use std::io::{self, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

pub fn start_daemon(path: &Path) -> io::Result<()> {
    Command::new(std::env::current_exe()?)
        .arg("daemon")
        .arg("--socket")
        .arg(path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    Ok(())
}

fn connect(path: &Path) -> io::Result<UnixStream> {
    crate::transport::private_socket_directory(path)?;
    let metadata = std::fs::symlink_metadata(path)?;
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    if !metadata.file_type().is_socket()
        || metadata.uid() != nix::unistd::geteuid().as_raw()
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "invalid private agent socket",
        ));
    }
    UnixStream::connect(path)
}

fn retryable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
    )
}

/// Copy the same private socket byte stream over SSH stdin and stdout.
pub fn bridge(path: &Path, auto_start: bool) -> io::Result<()> {
    let mut outgoing = match connect(path) {
        Ok(stream) => stream,
        Err(error) if auto_start && retryable(&error) => {
            start_daemon(path)?;
            let mut attempt = 0;
            loop {
                thread::sleep(Duration::from_millis(75));
                match connect(path) {
                    Ok(stream) => break stream,
                    Err(error) if retryable(&error) && attempt < 40 => attempt += 1,
                    Err(error) => return Err(error),
                }
            }
        }
        Err(error) => return Err(error),
    };
    let mut incoming = outgoing.try_clone()?;
    thread::Builder::new()
        .name("rucan-bridge-input".into())
        .spawn(move || {
            let _ = io::copy(&mut io::stdin().lock(), &mut incoming);
            let _ = incoming.shutdown(Shutdown::Write);
        })?;
    let mut stdout = io::stdout().lock();
    let mut bytes = [0; 16384];
    loop {
        let count = outgoing.read(&mut bytes)?;
        if count == 0 {
            return Ok(());
        }
        stdout.write_all(&bytes[..count])?;
        stdout.flush()?;
    }
}
