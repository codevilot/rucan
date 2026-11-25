use crate::terminal::TerminalReplies;
use portable_pty::{CommandBuilder, ExitStatus, MasterPty, PtySize, native_pty_system};
use std::error::Error;
use std::io::{Read, Write};
use std::num::NonZeroU16;
use std::sync::{Arc, Mutex, MutexGuard, mpsc};
use std::thread;
use tokio::runtime::Handle;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{oneshot, watch};

type SessionError = Box<dyn Error + Send + Sync>;
type OwnedMaster = Box<dyn MasterPty + Send>;
pub(crate) type PtyInput = Arc<Mutex<Option<mpsc::SyncSender<Vec<u8>>>>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Persistence {
    Temporary,
    Persistent,
}

#[derive(Clone, Debug)]
pub enum ProcessState {
    Running,
    Exited(ExitStatus),
    WaitFailed,
}

/// VT state cloned at one output sequence, independent of any client attachment.
pub struct Snapshot<'a> {
    pub sequence: u64,
    pub screen: &'a vt100::Screen,
    pub process: &'a ProcessState,
}

struct State {
    terminal: vt100::Parser<TerminalReplies>,
    sequence: watch::Sender<u64>,
    persistence: Persistence,
    process: ProcessState,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// The owning agent keeps this handle alive across changes in client connections.
pub struct NativeSession {
    state: Arc<Mutex<State>>,
    master: Arc<Mutex<Option<OwnedMaster>>>,
    input: PtyInput,
    shutdown: Mutex<Option<oneshot::Sender<()>>>,
    pid: Option<u32>,
}

fn terminal_size(size: PtySize) -> Result<(NonZeroU16, NonZeroU16), SessionError> {
    match (NonZeroU16::new(size.rows), NonZeroU16::new(size.cols)) {
        (Some(rows), Some(cols))
            if rows.get() <= 200
                && cols.get() <= 500
                && u32::from(rows.get()) * u32::from(cols.get()) <= 12_000 =>
        {
            Ok((rows, cols))
        }
        _ => Err("terminal size must fit 200 rows, 500 columns, and 12000 cells".into()),
    }
}

impl NativeSession {
    /// Start a native child with bounded terminal history and a dedicated output reader.
    pub fn spawn(
        command: CommandBuilder,
        size: PtySize,
        scrollback_lines: usize,
        persistence: Persistence,
    ) -> Result<Self, SessionError> {
        let (rows, cols) = terminal_size(size)?;
        if scrollback_lines > 10_000 {
            return Err("agent scrollback limit is 10000 lines".into());
        }
        let runtime = Handle::try_current()?;
        let mut child_signal = signal(SignalKind::child())?;
        let pair = native_pty_system().openpty(size)?;
        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let (sender, queued_input) = mpsc::sync_channel::<Vec<u8>>(16);
        let input = Arc::new(Mutex::new(Some(sender)));
        let state = Arc::new(Mutex::new(State {
            terminal: vt100::Parser::new_with_callbacks(
                rows,
                cols,
                scrollback_lines.min(200_000 / usize::from(cols.get())),
                TerminalReplies {
                    input: Arc::clone(&input),
                    reported_directory: None,
                },
            ),
            sequence: watch::channel(0).0,
            persistence,
            process: ProcessState::Running,
        }));

        let output_state = Arc::clone(&state);
        thread::Builder::new()
            .name("rucan-pty-read".into())
            .spawn(move || {
                let mut buffer = [0; 8192];
                loop {
                    match reader.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(count) => {
                            let mut state = lock(&output_state);
                            state.terminal.process(&buffer[..count]);
                            state.sequence.send_modify(|sequence| *sequence += 1);
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            })?;

        thread::Builder::new()
            .name("rucan-pty-write".into())
            .spawn(move || {
                while let Ok(bytes) = queued_input.recv() {
                    if writer.write_all(&bytes).is_err() {
                        break;
                    }
                }
            })?;

        let mut child = pair.slave.spawn_command(command)?;
        drop(pair.slave);
        let pid = child.process_id();
        let master = Arc::new(Mutex::new(Some(pair.master)));
        let child_master = Arc::clone(&master);
        let child_state = Arc::clone(&state);
        let child_input = Arc::clone(&input);
        let (shutdown, mut shutdown_request) = oneshot::channel();
        runtime.spawn(async move {
            // Only this task can reap or signal the child, which prevents signalling a reused PID.
            let process = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break ProcessState::Exited(status),
                    Err(_) => break ProcessState::WaitFailed,
                    Ok(None) => {}
                }
                tokio::select! {
                    _ = child_signal.recv() => {}
                    _ = &mut shutdown_request => {
                        let result = tokio::task::spawn_blocking(move || {
                            child.kill()?;
                            child.wait()
                        }).await;
                        break match result {
                            Ok(Ok(status)) => ProcessState::Exited(status),
                            _ => ProcessState::WaitFailed,
                        };
                    }
                }
            };
            lock(&child_input).take();
            lock(&child_master).take();
            let mut state = lock(&child_state);
            state.process = process;
            state.sequence.send_modify(|sequence| *sequence += 1);
        });

        Ok(Self {
            state,
            master,
            input,
            shutdown: Mutex::new(Some(shutdown)),
            pid,
        })
    }

    pub fn pid(&self) -> Option<u32> {
        self.pid
    }

    pub fn process_state(&self) -> ProcessState {
        lock(&self.state).process.clone()
    }

    pub(crate) fn reported_directory(&self) -> Option<String> {
        lock(&self.state)
            .terminal
            .callbacks()
            .reported_directory
            .clone()
    }

    pub fn persistence(&self) -> Persistence {
        lock(&self.state).persistence
    }

    pub fn set_persistence(&self, persistence: Persistence) {
        lock(&self.state).persistence = persistence;
    }

    /// Capture the active screen and modes even if no client was present for the updates.
    pub fn with_snapshot<T>(&self, project: impl FnOnce(Snapshot<'_>) -> T) -> T {
        let state = lock(&self.state);
        let sequence = *state.sequence.borrow();
        project(Snapshot {
            sequence,
            screen: state.terminal.screen(),
            process: &state.process,
        })
    }

    pub fn with_scrollback<T>(
        &self,
        offset: usize,
        project: impl FnOnce(Snapshot<'_>, usize) -> T,
    ) -> T {
        let mut state = lock(&self.state);
        let current = state.terminal.screen().scrollback();
        state.terminal.screen_mut().set_scrollback(offset);
        let screen = state.terminal.screen();
        let sequence = *state.sequence.borrow();
        let result = project(
            Snapshot {
                sequence,
                screen,
                process: &state.process,
            },
            screen.scrollback(),
        );
        state.terminal.screen_mut().set_scrollback(current);
        result
    }

    /// Subscribers share the latest sequence, so a stalled client never queues PTY output.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        lock(&self.state).sequence.subscribe()
    }

    /// Queue input without waiting for a child that stopped reading its PTY.
    pub fn write_input(&self, bytes: &[u8]) -> Result<(), std::io::Error> {
        use std::io::{Error, ErrorKind};
        if bytes.len() > 8192 {
            return Err(Error::new(
                ErrorKind::InvalidInput,
                "PTY input chunk exceeds 8192 bytes",
            ));
        }
        lock(&self.input)
            .as_ref()
            .ok_or_else(|| Error::new(ErrorKind::BrokenPipe, "PTY input closed"))?
            .try_send(bytes.to_vec())
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => {
                    Error::new(ErrorKind::WouldBlock, "PTY input queue full")
                }
                mpsc::TrySendError::Disconnected(_) => {
                    Error::new(ErrorKind::BrokenPipe, "PTY input closed")
                }
            })
    }

    pub fn resize(&self, size: PtySize) -> Result<(), SessionError> {
        let (rows, cols) = terminal_size(size)?;
        let mut state = lock(&self.state);
        lock(&self.master)
            .as_ref()
            .ok_or("PTY is closed")?
            .resize(size)?;
        state.terminal.set_size(rows, cols);
        state.sequence.send_modify(|sequence| *sequence += 1);
        Ok(())
    }

    /// Request termination from the task that owns the unreaped child.
    pub fn terminate(&self) {
        if let Some(shutdown) = lock(&self.shutdown).take() {
            let _ = shutdown.send(());
        }
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        self.terminate();
    }
}
