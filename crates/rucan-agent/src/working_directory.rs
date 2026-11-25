//! Look up the PTY child directory without sending commands to the terminal.

#[cfg(target_os = "linux")]
pub(crate) async fn process_directory(pid: u32) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()?
            .into_os_string()
            .into_string()
            .ok()
            .filter(|path| !path.ends_with(" (deleted)"))
    })
    .await
    .ok()?
}

#[cfg(target_os = "macos")]
pub(crate) async fn process_directory(pid: u32) -> Option<String> {
    use std::process::Stdio;
    use std::time::Duration;
    use tokio::io::AsyncReadExt;
    let mut child = tokio::process::Command::new("/usr/sbin/lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-F0n"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?.take(8193);
    tokio::time::timeout(Duration::from_secs(2), async {
        let mut data = Vec::new();
        stdout.read_to_end(&mut data).await.ok()?;
        if data.len() > 8192 || !child.wait().await.ok()?.success() {
            return None;
        }
        data.split(|&byte| byte == 0)
            .find_map(|field| field.strip_prefix(b"n/"))
            .and_then(|path| std::str::from_utf8(path).ok())
            .map(|path| format!("/{path}"))
    })
    .await
    .ok()?
}

pub(crate) fn osc_directory(params: &[&[u8]]) -> Option<String> {
    let [b"7", value] = params else {
        return None;
    };
    let uri = std::str::from_utf8(value).ok()?.strip_prefix("file://")?;
    let slash = uri.find('/')?;
    let path = &uri.as_bytes()[slash..];
    if path.len() > 4096 {
        return None;
    }
    let hex = |byte: u8| char::from(byte).to_digit(16);
    let mut decoded = Vec::with_capacity(path.len());
    let mut input = path.iter().copied();
    while let Some(byte) = input.next() {
        decoded.push(if byte == b'%' {
            u8::try_from(hex(input.next()?)? * 16 + hex(input.next()?)?).ok()?
        } else {
            byte
        });
    }
    String::from_utf8(decoded)
        .ok()
        .filter(|path| !path.chars().any(char::is_control))
}

#[cfg(test)]
mod tests {
    use super::osc_directory;

    #[test]
    fn accepts_absolute_file_reports_and_rejects_controls() {
        assert_eq!(
            osc_directory(&[b"7", b"file://host/home/user/My%20Project"]).as_deref(),
            Some("/home/user/My Project")
        );
        for uri in [
            b"file://host/no%1b".as_slice(),
            b"file://host/incomplete%",
            b"https://host/path",
        ] {
            assert!(osc_directory(&[b"7", uri]).is_none());
        }
    }
}
