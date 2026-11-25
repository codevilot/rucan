"""Exercise the compiled local workspace against real PTYs and Vim."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time


def read_until(master, marker, seconds=8):
    data = bytearray()
    deadline = time.monotonic() + seconds
    while marker not in data and time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            data.extend(os.read(master, 65536))
    if marker not in data:
        raise AssertionError(f"Missing {marker!r} in {bytes(data[-4000:])!r}")


def run():
    with tempfile.TemporaryDirectory(prefix="rucan-e2e-") as sandbox:
        path = Path(sandbox)
        path.chmod(0o700)
        env = dict(os.environ, TERM="xterm-256color", XDG_CONFIG_HOME=sandbox)
        env["XDG_CACHE_HOME"] = str(path / "cache")
        env["RUCAN_AGENT_SOCKET"] = str(path / "agent.sock")
        env["RUCAN_AGENT_BINARY"] = str(Path("target/debug/rucan-agent").resolve())
        node = ["node", "apps/cli/dist/main.js"]
        config_dir = path / "rucan"
        config_dir.mkdir(mode=0o700)
        project = path / "project"
        project.mkdir()
        (project / "README.md").write_text("RUCAN-FILE-PREVIEW\n")
        (config_dir / "config.yaml").write_text(
            'version: 1\nupdates: {check_on_startup: false}\n'
            f'workspaces: [{{name: tty-test, cwd: "{project}", command: "/bin/sh"}}]\n'
        )
        with subprocess.Popen(
            [env["RUCAN_AGENT_BINARY"], "serve", "--socket", env["RUCAN_AGENT_SOCKET"]],
            env=env,
        ) as agent:
            try:
                for _ in range(100):
                    if (path / "agent.sock").is_socket():
                        break
                    if agent.poll() is not None:
                        raise RuntimeError("agent exited before creating its socket")
                    time.sleep(0.025)
                exercise(node, env)
            finally:
                agent.terminate()
                agent.wait(timeout=5)


def exercise(node, env):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen(node, env=env, stdin=slave, stdout=slave, stderr=slave)
    try:
        read_until(master, b"ctrl+g Menu")
        os.write(master, b"printf 'PTY-%s\\n' smoke\r")
        read_until(master, b"PTY-smoke")

        os.write(master, b"\x07")
        read_until(master, b"P Pin")
        os.write(master, b"e")
        read_until(master, b"README.md")
        os.write(master, b"\r")
        read_until(master, b"RUCAN-FILE-PREVIEW")
        os.write(master, b"\x1b")
        read_until(master, b"P Pin")
        os.write(master, b"\x07")
        read_until(master, b"ctrl+g Menu")

        os.write(master, b"vim -Nu NONE -i NONE -n\r")
        read_until(master, b"VIM - Vi IMproved")
        os.write(master, b"iFrom-Vim")
        read_until(master, b"From-Vim")
        os.write(master, b"\x1b:q!\r")
        time.sleep(0.15)

        os.write(master, b"\x07")
        read_until(master, b"P Pin")
        os.write(master, b"p")
        read_until(master, "◆".encode())
        os.write(master, b"/")
        read_until(master, b"Command  /")
        os.write(master, b"exit\r")
        read_until(master, b"Close UI and keep all sessions")
        os.write(master, b"\r")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
        assert termios.tcgetattr(slave) == original

        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        assert len(sessions) == 1 and sessions[0]["persistent"]
        assert sessions[0]["state"]["type"] == "running"
        subprocess.check_call(node + ["kill", sessions[0]["id"]], env=env)
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    run()
    print("Local TTY smoke passed")
