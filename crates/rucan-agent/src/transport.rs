use crate::control::{Registry, snapshot_json};
use crate::filesystem;
use crate::framing::{Frame, MAX_FRAME_BYTES, read_frame, write_frame};
use crate::operation::{Operation, Request};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, ErrorKind};
use std::os::unix::fs::{DirBuilderExt, FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{Notify, Semaphore};
use tokio::time::timeout;
use uuid::Uuid;

const VERSION: u16 = 1;
const CONTROL: u8 = 1;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, tag = "type", rename_all = "lowercase")]
enum ClientHello {
    Hello {
        #[serde(rename = "minVersion")]
        min_version: u16,
        #[serde(rename = "maxVersion")]
        max_version: u16,
        capabilities: Vec<String>,
    },
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Reply {
    Welcome {
        version: u16,
        #[serde(rename = "maxFrameBytes")]
        max_frame_bytes: usize,
        capabilities: Vec<&'static str>,
    },
    Error {
        code: &'static str,
    },
}

fn negotiate(payload: &[u8]) -> Reply {
    let Ok(ClientHello::Hello {
        min_version,
        max_version,
        capabilities,
    }) = serde_json::from_slice(payload)
    else {
        return Reply::Error {
            code: "invalid-hello",
        };
    };
    let mut names = HashSet::new();
    let valid_capabilities = capabilities.len() <= 64
        && capabilities.iter().all(|name| {
            name.len() <= 64
                && name.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
                && names.insert(name)
        });
    if min_version == 0 || min_version > max_version || !valid_capabilities {
        Reply::Error {
            code: "invalid-hello",
        }
    } else if (min_version..=max_version).contains(&VERSION) {
        Reply::Welcome {
            version: VERSION,
            max_frame_bytes: MAX_FRAME_BYTES,
            capabilities: ["native-session", "workspace-cwd"]
                .into_iter()
                .filter(|capability| names.iter().any(|name| name.as_str() == *capability))
                .collect(),
        }
    } else {
        Reply::Error {
            code: "incompatible-version",
        }
    }
}

struct SocketOwner {
    path: PathBuf,
    _lock: File,
}

impl Drop for SocketOwner {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn socket_directory(path: &Path) -> io::Result<&Path> {
    path.parent().filter(|_| path.is_absolute()).ok_or_else(|| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "agent socket needs an absolute path",
        )
    })
}

pub(crate) fn private_socket_directory(path: &Path) -> io::Result<fs::Metadata> {
    let directory = socket_directory(path)?;
    let metadata = fs::symlink_metadata(directory)?;
    if !metadata.is_dir()
        || metadata.uid() != nix::unistd::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "agent socket directory must be private, owned by the current user and not a symlink",
        ));
    }

    Ok(metadata)
}

async fn bind(path: &Path) -> io::Result<(UnixListener, SocketOwner)> {
    let directory = socket_directory(path)?;
    match DirBuilder::new().mode(0o700).create(directory) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = private_socket_directory(path)?;

    let mut lock_path = path.as_os_str().to_os_string();
    lock_path.push(".lock");
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(lock_path)?;
    let lock_metadata = lock.metadata()?;
    if !lock_metadata.is_file()
        || lock_metadata.uid() != metadata.uid()
        || lock_metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "invalid agent startup lock",
        ));
    }
    lock.try_lock().map_err(io::Error::from)?;
    match fs::symlink_metadata(path) {
        Ok(entry) if entry.file_type().is_socket() && entry.uid() == metadata.uid() => {
            match timeout(Duration::from_millis(150), UnixStream::connect(path)).await {
                Ok(Err(error)) if error.kind() == ErrorKind::ConnectionRefused => {
                    fs::remove_file(path)?
                }
                _ => {
                    return Err(io::Error::new(
                        ErrorKind::AddrInUse,
                        "socket already in use",
                    ));
                }
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(error),
        Ok(_) => {
            return Err(io::Error::new(
                ErrorKind::AlreadyExists,
                "unexpected entry at agent socket path",
            ));
        }
    }
    let listener = UnixListener::bind(path)?;
    let owner = SocketOwner {
        path: path.into(),
        _lock: lock,
    };
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok((listener, owner))
}

async fn handshake(socket: &mut UnixStream) -> io::Result<bool> {
    let Some(frame) = read_frame(socket).await? else {
        return Ok(false);
    };
    let reply = if frame.kind == CONTROL {
        negotiate(&frame.payload)
    } else {
        Reply::Error {
            code: "invalid-hello",
        }
    };
    write_frame(socket, CONTROL, &serde_json::to_vec(&reply)?).await?;
    Ok(matches!(reply, Reply::Welcome { .. }))
}

struct WatchBase {
    session: String,
    sequence: u64,
    rows: u64,
    cols: u64,
    lines: Vec<Value>,
}

struct Connection {
    id: Uuid,
    registry: Arc<Registry>,
    path: Arc<PathBuf>,
    watch_base: Option<WatchBase>,
    filesystem_slots: Arc<Semaphore>,
    shutdown: Arc<Notify>,
    shutdown_requested: bool,
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.registry.release(self.id);
        if self.shutdown_requested {
            self.shutdown.notify_one();
        }
    }
}

impl Connection {
    async fn workspace_cwd(&self, id: &str) -> Result<Value, String> {
        let _permit = self
            .filesystem_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "agent filesystem request limit reached")?;
        let session = self.registry.session(id)?;
        let foreground = session.foreground_pid();
        let directory = async {
            if matches!(
                session.process_state(),
                crate::session::ProcessState::Running
            ) {
                crate::working_directory::process_directory(session.pid()?).await
            } else {
                None
            }
        };
        let ssh = async { crate::foreground_ssh::lookup(foreground?).await };
        let (path, ssh) = tokio::join!(directory, ssh);
        if !matches!(
            session.process_state(),
            crate::session::ProcessState::Running
        ) {
            return Ok(json!({"path": null, "reportedPath": null}));
        }
        let ssh = if session.foreground_pid() == foreground {
            match ssh {
                Some(crate::foreground_ssh::ForegroundSsh::Destination(target)) => {
                    json!({"type": "destination", "target": target})
                }
                Some(crate::foreground_ssh::ForegroundSsh::Unsupported) => {
                    json!({"type": "unsupported"})
                }
                None => Value::Null,
            }
        } else {
            Value::Null
        };
        Ok(
            json!({"path": path, "reportedPath": session.reported_directory(), "foregroundSsh": ssh}),
        )
    }

    async fn handle(&mut self, mut socket: UnixStream) -> io::Result<()> {
        if !timeout(Duration::from_secs(5), handshake(&mut socket)).await?? {
            return Ok(());
        }
        while let Some(frame) = read_frame(&mut socket).await? {
            let mut unexpected_input = [0; 1];
            let response = tokio::select! {
                biased;
                response = self.response(frame) => response?,
                // Requests are serialized, so input while waiting is a cancellation or disconnect.
                _ = socket.read(&mut unexpected_input) => return Ok(()),
            };
            timeout(
                Duration::from_secs(5),
                write_frame(&mut socket, CONTROL, &serde_json::to_vec(&response)?),
            )
            .await??;
            if self.shutdown_requested {
                break;
            }
        }
        Ok(())
    }

    async fn watch(&mut self, id: &str, after: u64) -> Result<Value, String> {
        let native = self.registry.session(id)?;
        let mut sequence = native.subscribe();
        if *sequence.borrow_and_update() <= after {
            match timeout(Duration::from_secs(25), sequence.changed()).await {
                Err(_) => return Ok(Value::Null),
                Ok(Err(_)) => return Err("session output closed".into()),
                Ok(Ok(())) => {}
            }
        }
        let mut snapshot = snapshot_json(&native);
        let sequence = snapshot["sequence"].as_u64().expect("projected sequence");
        let grid = &mut snapshot["grid"];
        let rows = grid["rows"].as_u64().expect("projected rows");
        let cols = grid["cols"].as_u64().expect("projected columns");
        let lines = grid["lines"].as_array().expect("projected lines").clone();
        if let Some(previous) = self.watch_base.as_ref()
            && previous.session == id
            && previous.sequence == after
            && previous.rows == rows
            && previous.cols == cols
        {
            let changes: Vec<_> = lines
                .iter()
                .zip(&previous.lines)
                .enumerate()
                .filter(|(_, (next, old))| next != old)
                .map(|(index, (line, _))| json!([index, line]))
                .collect();
            grid.as_object_mut()
                .expect("projected grid")
                .remove("lines");
            grid["patch"] = Value::Array(changes);
            snapshot["baseSequence"] = json!(after);
            snapshot
                .as_object_mut()
                .expect("projected snapshot")
                .remove("text");
        }
        self.watch_base = Some(WatchBase {
            session: id.to_owned(),
            sequence,
            rows,
            cols,
            lines,
        });
        Ok(snapshot)
    }

    async fn filesystem<T: Serialize + Send + 'static>(
        &self,
        operation: impl FnOnce() -> Result<T, String> + Send + 'static,
    ) -> Result<Value, String> {
        let permit = Arc::clone(&self.filesystem_slots)
            .try_acquire_owned()
            .map_err(|_| "agent filesystem request limit reached")?;
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            operation()
        })
        .await
        .map_err(|_| "filesystem worker failed")??;
        serde_json::to_value(result).map_err(|error| error.to_string())
    }

    async fn response(&mut self, frame: Frame) -> io::Result<Value> {
        let (id, result) = match frame.kind {
            CONTROL => {
                let request: Request = serde_json::from_slice(&frame.payload)?;
                (
                    request.id,
                    match request.operation {
                        Operation::Shutdown { force } => {
                            self.registry.begin_shutdown(force).map(|()| {
                                self.shutdown_requested = true;
                                Value::Null
                            })
                        }
                        Operation::Watch { session, after } => self.watch(&session, after).await,
                        Operation::WorkspaceCwd { session } => self.workspace_cwd(&session).await,
                        Operation::FsList { path, exclusions } => {
                            self.filesystem(move || filesystem::list(&path, &exclusions))
                                .await
                        }
                        Operation::FsPreview { path } => {
                            self.filesystem(move || filesystem::preview(&path)).await
                        }
                        Operation::TmuxList => crate::tmux::list().await.and_then(|listing| {
                            serde_json::to_value(listing).map_err(|error| error.to_string())
                        }),
                        Operation::TmuxOpen {
                            target,
                            name,
                            cwd,
                            rows,
                            cols,
                        } => match crate::tmux::open(target.as_deref(), &name, &cwd).await {
                            Ok(target) => self
                                .registry
                                .open_tmux(self.id, &self.path, target, rows, cols),
                            Err(error) => Err(error),
                        },
                        operation => self.registry.execute(self.id, &self.path, operation),
                    },
                )
            }
            2 => {
                let Some((header, input)) = frame.payload.split_at_checked(20) else {
                    return Err(io::Error::new(
                        ErrorKind::InvalidData,
                        "invalid input frame",
                    ));
                };
                let id = u32::from_be_bytes(header[..4].try_into().expect("four-byte request ID"));
                let session = Uuid::from_slice(&header[4..]).expect("sixteen-byte UUID");
                let result = self
                    .registry
                    .controller(self.id, session)
                    .ok_or_else(|| "attachment does not own the input lease".to_owned())
                    .and_then(|native| native.write_input(input).map_err(|error| error.to_string()))
                    .map(|()| Value::Null);
                (id, result)
            }
            _ => {
                return Err(io::Error::new(
                    ErrorKind::InvalidData,
                    "unsupported frame kind",
                ));
            }
        };
        Ok(match result {
            Ok(value) => json!({"id": id, "ok": true, "value": value}),
            Err(error) => json!({"id": id, "ok": false, "error": error}),
        })
    }
}

/// Run the per-user listener with bounded concurrent negotiations.
pub async fn serve(path: &Path) -> io::Result<()> {
    let (listener, _owner) = bind(path).await?;
    let capacity = Arc::new(Semaphore::new(64));
    let registry = Arc::new(Registry::default());
    let filesystem_slots = Arc::new(Semaphore::new(8));
    let path = Arc::new(path.to_owned());
    let shutdown = Arc::new(Notify::new());
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    loop {
        tokio::select! {
            _ = terminate.recv() => break,
            _ = shutdown.notified() => break,
            incoming = listener.accept() => {
                let (socket, _) = incoming?;
                if !socket.peer_cred().is_ok_and(|peer| peer.uid() == nix::unistd::geteuid().as_raw()) {
                    continue;
                }
                let Ok(permit) = Arc::clone(&capacity).try_acquire_owned() else {
                    continue;
                };
                let mut connection = Connection { id: Uuid::new_v4(), registry: Arc::clone(&registry), path: Arc::clone(&path), watch_base: None, filesystem_slots: Arc::clone(&filesystem_slots), shutdown: Arc::clone(&shutdown), shutdown_requested: false };
                tokio::spawn(async move {
                    let _permit = permit;
                    let _ = connection.handle(socket).await;
                });
            }
        }
    }
    let _ = timeout(Duration::from_secs(3), registry.stop_all()).await;
    Ok(())
}
