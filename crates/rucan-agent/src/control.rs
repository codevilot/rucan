use crate::operation::Operation;
use crate::paths::resolve_path;
use crate::session::{NativeSession, Persistence, ProcessState, Snapshot};
use crate::terminal::Grid;
use portable_pty::{CommandBuilder, PtySize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{
    Arc, Mutex, MutexGuard,
    atomic::{AtomicBool, Ordering},
};
use uuid::Uuid;

struct Entry {
    name: String,
    custom_name: Option<String>,
    cwd: String,
    tmux_id: Option<String>,
    ssh_target: Option<String>,
    ssh_reconnect: bool,
    native: Arc<NativeSession>,
    controller: Option<Uuid>,
}

#[derive(Default)]
pub(crate) struct Registry {
    sessions: Mutex<HashMap<Uuid, Entry>>,
    closing: AtomicBool,
}

fn size(rows: u16, cols: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

fn persistence(persistent: bool) -> Persistence {
    if persistent {
        Persistence::Persistent
    } else {
        Persistence::Temporary
    }
}

fn describe_process(process: &ProcessState) -> Value {
    match process {
        ProcessState::Running => json!({"type": "running"}),
        ProcessState::Exited(status) => json!({
            "type": "exited", "code": status.exit_code(), "signal": status.signal()
        }),
        ProcessState::WaitFailed => json!({"type": "wait-failed"}),
    }
}

fn describe(id: Uuid, entry: &Entry) -> Value {
    json!({
        "id": id.to_string(),
        "name": entry.custom_name.as_ref().unwrap_or(&entry.name),
        "customName": entry.custom_name.is_some(),
        "cwd": entry.cwd,
        "backend": if entry.tmux_id.is_some() { "tmux" } else { "native" },
        "ownership": if entry.tmux_id.is_some() { "external" } else { "managed" },
        "tmuxId": entry.tmux_id,
        "sshTarget": entry.ssh_target,
        "sshReconnect": entry.ssh_reconnect,
        "pid": entry.native.pid(),
        "persistent": entry.native.persistence() == Persistence::Persistent,
        "state": describe_process(&entry.native.process_state()),
    })
}

impl Registry {
    fn lock(&self) -> MutexGuard<'_, HashMap<Uuid, Entry>> {
        self.sessions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub(crate) fn release(&self, connection: Uuid) {
        for entry in self.lock().values_mut() {
            if entry.controller == Some(connection) {
                entry.controller = None;
            }
        }
    }

    pub(crate) fn begin_shutdown(&self, force: bool) -> Result<(), String> {
        let sessions = self.lock();
        if !force
            && sessions.values().any(|entry| {
                entry.tmux_id.is_none()
                    && matches!(entry.native.process_state(), ProcessState::Running)
            })
        {
            return Err("managed sessions remain active; use shutdown --force to stop them".into());
        }
        self.closing.store(true, Ordering::Release);
        Ok(())
    }

    pub(crate) async fn stop_all(&self) {
        self.closing.store(true, Ordering::Release);
        let tasks: Vec<_> = self
            .lock()
            .values()
            .map(|entry| Arc::clone(&entry.native))
            .collect();
        for session in &tasks {
            session.terminate();
        }
        for session in &tasks {
            let mut updates = session.subscribe();
            while matches!(session.process_state(), ProcessState::Running) {
                if updates.changed().await.is_err() {
                    break;
                }
            }
        }
    }

    pub(crate) fn controller(&self, connection: Uuid, id: Uuid) -> Option<Arc<NativeSession>> {
        let sessions = self.lock();
        let entry = sessions.get(&id)?;
        (entry.controller == Some(connection)).then(|| Arc::clone(&entry.native))
    }

    pub(crate) fn session(&self, id: &str) -> Result<Arc<NativeSession>, String> {
        let id = Uuid::parse_str(id).map_err(|_| "invalid session identifier")?;
        self.lock()
            .get(&id)
            .map(|entry| Arc::clone(&entry.native))
            .ok_or_else(|| "unknown session".into())
    }

    pub(crate) fn open_tmux(
        &self,
        connection: Uuid,
        path: &Path,
        target: crate::tmux::Target,
        rows: u16,
        cols: u16,
    ) -> Result<Value, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("agent is shutting down".into());
        }
        let mut sessions = self.lock();
        if let Some((&id, entry)) = sessions.iter_mut().find(|(_, entry)| {
            entry.tmux_id.as_deref() == Some(&target.id)
                && matches!(entry.native.process_state(), ProcessState::Running)
        }) {
            if entry.controller.is_none() {
                entry.controller = Some(connection);
            }
            return Ok(describe(id, entry));
        }
        spawn(
            &mut sessions,
            connection,
            path,
            SpawnSpec {
                name: target.name,
                cwd: target.cwd,
                command: "tmux".into(),
                args: vec!["attach-session".into(), "-t".into(), target.id.clone()],
                rows,
                cols,
                persistent: true,
                scrollback: 1000,
                tmux_id: Some(target.id),
            },
        )
    }

    pub(crate) fn execute(
        &self,
        connection: Uuid,
        socket_path: &Path,
        operation: Operation,
    ) -> Result<Value, String> {
        if self.closing.load(Ordering::Acquire) {
            return Err("agent is shutting down".into());
        }
        let mut sessions = self.lock();
        let session = match operation {
            Operation::Watch { .. }
            | Operation::Shutdown { .. }
            | Operation::FsList { .. }
            | Operation::WorkspaceCwd { .. }
            | Operation::FsPreview { .. }
            | Operation::TmuxList
            | Operation::TmuxOpen { .. } => {
                unreachable!("handled by asynchronous transport")
            }
            Operation::List => {
                return Ok(Value::Array(
                    sessions
                        .iter()
                        .map(|(&id, entry)| describe(id, entry))
                        .collect(),
                ));
            }
            Operation::Create {
                command,
                args,
                cwd,
                name,
                rows,
                cols,
                persistent,
                scrollback,
            } => {
                return spawn(
                    &mut sessions,
                    connection,
                    socket_path,
                    SpawnSpec {
                        command,
                        args,
                        cwd,
                        name,
                        rows,
                        cols,
                        persistent,
                        scrollback: scrollback.unwrap_or(1000),
                        tmux_id: None,
                    },
                );
            }
            Operation::Attach { ref session }
            | Operation::Detach { ref session, .. }
            | Operation::Scroll { ref session, .. }
            | Operation::Rename { ref session, .. }
            | Operation::Snapshot { ref session }
            | Operation::Pin { ref session, .. }
            | Operation::Resize { ref session, .. }
            | Operation::Kill { ref session } => session,
        };
        let id = Uuid::parse_str(session).map_err(|_| "invalid session identifier")?;
        let entry = sessions.get_mut(&id).ok_or("unknown session")?;

        match operation {
            Operation::Attach { .. } => {
                if entry.controller.is_none() {
                    entry.controller = Some(connection);
                }
                Ok(
                    json!({"controlsInput": entry.controller == Some(connection), "session": describe(id, entry)}),
                )
            }
            Operation::Detach { force, .. } => {
                if force == Some(true) || entry.controller == Some(connection) {
                    entry.controller = None;
                }
                Ok(Value::Null)
            }
            Operation::Rename { name, .. } => {
                entry.custom_name = if name.is_empty() {
                    None
                } else {
                    validate_name(&name)?;
                    Some(name)
                };
                Ok(describe(id, entry))
            }
            Operation::Scroll { offset, .. } => {
                let native = Arc::clone(&entry.native);
                drop(sessions);
                Ok(
                    native.with_scrollback(offset.min(10_000), |snapshot, actual| {
                        let mut result = project_snapshot(snapshot);
                        result["scrollback"] = json!(actual);
                        result
                    }),
                )
            }
            Operation::Snapshot { .. } => {
                let native = Arc::clone(&entry.native);
                drop(sessions);
                Ok(snapshot_json(&native))
            }
            Operation::Pin { persistent, .. } => {
                if entry.tmux_id.is_some() {
                    return Err("tmux owns persistence for this session".into());
                }
                entry.native.set_persistence(persistence(persistent));
                Ok(describe(id, entry))
            }
            Operation::Resize { rows, cols, .. } => {
                if entry.controller != Some(connection) {
                    return Err("attachment does not own the input lease".into());
                }
                entry
                    .native
                    .resize(size(rows, cols))
                    .map_err(|error| error.to_string())?;
                Ok(Value::Null)
            }
            Operation::Kill { .. } => {
                if entry.tmux_id.is_some() {
                    return Err("refusing to stop an externally owned tmux session".into());
                }
                entry.native.terminate();
                Ok(Value::Null)
            }
            Operation::Create { .. }
            | Operation::List
            | Operation::Watch { .. }
            | Operation::Shutdown { .. }
            | Operation::FsList { .. }
            | Operation::WorkspaceCwd { .. }
            | Operation::FsPreview { .. }
            | Operation::TmuxList
            | Operation::TmuxOpen { .. } => {
                unreachable!("handled before lookup")
            }
        }
    }
}

struct SpawnSpec {
    command: String,
    args: Vec<String>,
    cwd: String,
    name: String,
    rows: u16,
    cols: u16,
    persistent: bool,
    scrollback: usize,
    tmux_id: Option<String>,
}

fn spawn(
    sessions: &mut HashMap<Uuid, Entry>,
    connection: Uuid,
    socket_path: &Path,
    spec: SpawnSpec,
) -> Result<Value, String> {
    let SpawnSpec {
        command,
        args,
        cwd,
        name,
        rows,
        cols,
        persistent,
        scrollback,
        tmux_id,
    } = spec;
    if sessions.len() >= 64 {
        sessions.retain(|_, entry| matches!(entry.native.process_state(), ProcessState::Running));
    }
    if sessions.len() >= 64 {
        return Err("session limit reached".into());
    }
    validate_name(&name)?;
    if command.trim().is_empty()
        || command.len() > 4096
        || args.len() > 128
        || args.iter().any(|arg| arg.len() > 4096)
        || cwd.len() > 4096
    {
        return Err("invalid session name, command, arguments or directory".into());
    }
    let cwd = resolve_path(&cwd)?;
    let id = Uuid::new_v4();
    let reconnect_target = ssh_reconnect_target(&command, &args);
    let ssh_reconnect = reconnect_target.is_some();
    let ssh_target = reconnect_target.or_else(|| ssh_target(&command, &args));
    let mut program = CommandBuilder::new(command);
    program.args(args);
    program.cwd(&cwd);
    program.env("TERM", "xterm-256color");
    program.env("RUCAN_SESSION_ID", id.to_string());
    program.env("RUCAN_AGENT_SOCKET", socket_path);
    let native = NativeSession::spawn(
        program,
        size(rows, cols),
        scrollback,
        persistence(persistent),
    )
    .map_err(|error| format!("could not start session: {error}"))?;
    let entry = Entry {
        name,
        custom_name: None,
        tmux_id,
        ssh_target,
        ssh_reconnect,
        cwd: cwd
            .into_os_string()
            .into_string()
            .map_err(|_| "workspace directory is not UTF-8")?,
        native: Arc::new(native),
        controller: Some(connection),
    };
    let description = describe(id, &entry);
    sessions.insert(id, entry);
    Ok(description)
}

fn ssh_target(command: &str, args: &[String]) -> Option<String> {
    if Path::new(command).file_name()?.to_str()? != "ssh" {
        return None;
    }
    let args = match args {
        [
            flag,
            master,
            persist_flag,
            persist,
            path_flag,
            path,
            rest @ ..,
        ] if flag == "-o"
            && master == "ControlMaster=auto"
            && persist_flag == "-o"
            && persist == "ControlPersist=60"
            && path_flag == "-o"
            && path.starts_with("ControlPath=/tmp/rucan-ssh-")
            && path.ends_with("/%C") =>
        {
            rest
        }
        _ => args,
    };
    let target = match args {
        [target] => target,
        [end, target] if end == "--" => target,
        [option, verification, end, target]
            if option == "-o" && verification == "StrictHostKeyChecking=ask" && end == "--" =>
        {
            target
        }
        [option, verification, terminal, end, target, _]
            if option == "-o"
                && verification == "StrictHostKeyChecking=ask"
                && terminal == "-t"
                && end == "--" =>
        {
            target
        }
        _ => return None,
    };
    valid_ssh_target(target).then(|| target.clone())
}

fn ssh_reconnect_target(command: &str, args: &[String]) -> Option<String> {
    if Path::new(command).file_name()?.to_str()? != "node" {
        return None;
    }
    let args = if args
        .first()
        .is_some_and(|arg| arg == "--experimental-strip-types")
    {
        &args[1..]
    } else {
        args
    };
    let [runner, target, ..] = args else {
        return None;
    };
    let runner = Path::new(runner);
    (runner.is_absolute()
        && ["ssh-reconnect-runner.js", "ssh-reconnect-runner.ts"]
            .contains(&runner.file_name()?.to_str()?)
        && valid_ssh_target(target))
    .then(|| target.clone())
}

fn valid_ssh_target(target: &str) -> bool {
    (1..=128).contains(&target.len())
        && !target.starts_with('-')
        && target
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:@-".contains(&byte))
}
fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name.len() > 128 || name.chars().any(char::is_control) {
        return Err("invalid workspace name".into());
    }
    Ok(())
}

pub(crate) fn snapshot_json(native: &NativeSession) -> Value {
    native.with_snapshot(project_snapshot)
}

fn project_snapshot(snapshot: Snapshot<'_>) -> Value {
    let (row, column) = snapshot.screen.cursor_position();
    let contents: String = snapshot
        .screen
        .contents()
        .chars()
        .filter(|ch| *ch == '\n' || !ch.is_control())
        .collect();
    json!({
        "sequence": snapshot.sequence, "text": contents,
        "state": describe_process(snapshot.process),
        "alternate": snapshot.screen.alternate_screen(),
        "cursor": { "row": row, "column": column },
        "grid": Grid::project(snapshot.screen),
    })
}
