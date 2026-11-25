use crate::paths::resolve_path;
use serde::Serialize;
use std::io::ErrorKind;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Serialize)]
pub(crate) struct Target {
    pub id: String,
    pub name: String,
    pub cwd: String,
}

#[derive(Serialize)]
pub(crate) struct Inventory {
    available: bool,
    sessions: Vec<Target>,
}

#[derive(Debug)]
enum Failure {
    Missing,
    Failed,
    Io(String),
}

async fn execute(args: &[&str]) -> Result<String, Failure> {
    let mut command = Command::new("tmux");
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = command.spawn().map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            Failure::Missing
        } else {
            Failure::Io(error.to_string())
        }
    })?;
    let stdout = child.stdout.take().ok_or(Failure::Failed)?;
    timeout(Duration::from_secs(3), async {
        let mut bytes = Vec::new();
        stdout
            .take(131_073)
            .read_to_end(&mut bytes)
            .await
            .map_err(|error| Failure::Io(error.to_string()))?;
        if bytes.len() > 131_072 {
            return Err(Failure::Io("tmux response exceeds limit".into()));
        }
        let status = child
            .wait()
            .await
            .map_err(|error| Failure::Io(error.to_string()))?;
        if !status.success() {
            return Err(Failure::Failed);
        }
        String::from_utf8(bytes).map_err(|_| Failure::Io("tmux response was not UTF-8".into()))
    })
    .await
    .map_err(|_| Failure::Io("tmux did not respond in time".into()))?
}

fn describe(error: Failure) -> String {
    match error {
        Failure::Missing => "tmux is unavailable on this host".into(),
        Failure::Failed => "tmux did not accept the operation".into(),
        Failure::Io(detail) => detail,
    }
}

fn valid_id(value: &str) -> bool {
    value.strip_prefix('$').is_some_and(|number| {
        !number.is_empty() && number.len() <= 16 && number.bytes().all(|byte| byte.is_ascii_digit())
    })
}

pub(crate) async fn list() -> Result<Inventory, String> {
    // tmux normalizes literal control characters in command arguments.
    const DELIMITER: &str = "|RUCAN|";
    let response = execute(&[
        "list-sessions",
        "-F",
        "#{session_id}|RUCAN|#{session_name}|RUCAN|#{session_path}",
    ])
    .await;
    let sessions = match response {
        Err(Failure::Missing) => {
            return Ok(Inventory {
                available: false,
                sessions: vec![],
            });
        }
        Err(Failure::Failed) => Vec::new(),
        Err(error) => return Err(describe(error)),
        Ok(output) => output
            .lines()
            .take(256)
            .filter_map(|line| {
                let mut fields = line.splitn(3, DELIMITER);
                let (id, name, cwd) = (fields.next()?, fields.next()?, fields.next()?);
                if !valid_id(id)
                    || !cwd.starts_with('/')
                    || name.is_empty()
                    || name.chars().any(char::is_control)
                {
                    return None;
                }
                Some(Target {
                    id: id.into(),
                    name: name.into(),
                    cwd: cwd.into(),
                })
            })
            .collect(),
    };
    Ok(Inventory {
        available: true,
        sessions,
    })
}

pub(crate) async fn open(
    selected: Option<&str>,
    name: &str,
    directory: &str,
) -> Result<Target, String> {
    if let Some(selected) = selected {
        return list()
            .await?
            .sessions
            .into_iter()
            .find(|session| session.id == selected || session.name == selected)
            .ok_or_else(|| "unknown tmux session".into());
    }
    if name.is_empty()
        || name.len() > 96
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("tmux session names require letters, digits, hyphens or underscores".into());
    }
    let cwd = resolve_path(directory)?;
    let cwd = cwd.to_str().ok_or("tmux directory is not UTF-8")?;
    let result = execute(&[
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{session_id}",
        "-s",
        name,
        "-c",
        cwd,
    ])
    .await
    .map_err(describe)?;
    let id = result.trim();
    if !valid_id(id) {
        return Err("invalid tmux session identifier".into());
    }
    Ok(Target {
        id: id.into(),
        name: name.into(),
        cwd: cwd.into(),
    })
}
