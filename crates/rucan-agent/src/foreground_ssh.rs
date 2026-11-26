//! Inspect only the PTY foreground group leader. Never replay its options or remote command.

use std::path::Path;

const MAX_COMMAND: usize = 8192;

pub(crate) enum ForegroundSsh {
    Destination(String),
    Unsupported,
}

fn is_ssh(command: &[u8]) -> bool {
    std::str::from_utf8(command)
        .ok()
        .and_then(|command| Path::new(command).file_name())
        .is_some_and(|name| name == "ssh")
}

fn destination(args: &[&[u8]]) -> ForegroundSsh {
    let target = match args {
        [target] | [b"--", target] => *target,
        _ => return ForegroundSsh::Unsupported,
    };
    if target.is_empty()
        || target.len() > 128
        || target.starts_with(b"-")
        || !target
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_.:@-".contains(byte))
    {
        return ForegroundSsh::Unsupported;
    }
    match std::str::from_utf8(target) {
        Ok(target) => ForegroundSsh::Destination(target.into()),
        Err(_) => ForegroundSsh::Unsupported,
    }
}

#[cfg(target_os = "linux")]
pub(crate) async fn lookup(pid: u32) -> Option<ForegroundSsh> {
    use std::io::Read;
    tokio::task::spawn_blocking(move || {
        let executable = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
        if !is_ssh(executable.as_os_str().as_encoded_bytes()) {
            return None;
        }
        let mut bytes = Vec::new();
        std::fs::File::open(format!("/proc/{pid}/cmdline"))
            .ok()?
            .take(MAX_COMMAND as u64 + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() > MAX_COMMAND {
            return Some(ForegroundSsh::Unsupported);
        }
        let bytes = bytes.strip_suffix(b"\0")?;
        let mut fields = bytes.split(|&byte| byte == 0);
        if !is_ssh(fields.next()?) {
            return Some(ForegroundSsh::Unsupported);
        }
        Some(destination(&fields.collect::<Vec<_>>()))
    })
    .await
    .ok()?
}

#[cfg(target_os = "macos")]
pub(crate) async fn lookup(pid: u32) -> Option<ForegroundSsh> {
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    let mut child = tokio::process::Command::new("/bin/ps")
        .args(["-ww", "-p", &pid.to_string(), "-o", "ucomm=", "-o", "args="])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?.take(MAX_COMMAND as u64 + 1);
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await.ok()?;
        let mut fields = bytes
            .split(|byte| byte.is_ascii_whitespace())
            .filter(|part| !part.is_empty());
        if !is_ssh(fields.next()?) {
            return None;
        }
        if bytes.len() > MAX_COMMAND || !is_ssh(fields.next()?) {
            return Some(ForegroundSsh::Unsupported);
        }
        if !child.wait().await.ok()?.success() {
            return None;
        }
        Some(destination(&fields.collect::<Vec<_>>()))
    })
    .await
    .ok()?
}
