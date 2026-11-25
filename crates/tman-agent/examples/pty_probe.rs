use portable_pty::{CommandBuilder, PtySize, native_pty_system};

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let mut arguments = std::env::args_os().skip(1);
    let program = arguments.next().ok_or("missing program")?;
    let mut command = CommandBuilder::new(program);
    command.args(arguments);
    command.env("TERM", "xterm-256color");
    let pair = native_pty_system().openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;
    let mut child = pair.slave.spawn_command(command)?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader()?;
    std::io::copy(&mut reader, &mut std::io::stdout().lock())?;
    if !child.wait()?.success() {
        return Err("PTY fixture failed".into());
    }
    Ok(())
}
