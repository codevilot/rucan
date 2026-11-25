"""Exercise the compiled local workspace against real PTYs and Vim."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shlex
import signal
import struct
import subprocess
import sys
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
    return data


def run():
    with tempfile.TemporaryDirectory(prefix="rucan-e2e-") as sandbox:
        path = Path(sandbox)
        path.chmod(0o700)
        env = dict(os.environ, TERM="xterm-256color", XDG_CONFIG_HOME=sandbox)
        env.pop("RUCAN_SESSION_ID", None)
        env["XDG_CACHE_HOME"] = str(path / "cache")
        env["RUCAN_AGENT_SOCKET"] = str(path / "agent.sock")
        env["RUCAN_AGENT_BINARY"] = str(Path("target/debug/rucan-agent").resolve())
        bin_dir = path / "bin"
        bin_dir.mkdir()
        ssh_fixture = bin_dir / "ssh"
        ssh_fixture.write_text(
            '#!/bin/sh\n'
            'if [ "$*" = "-o StrictHostKeyChecking=ask -- ops@192.0.2.7" ]; then\n'
            "  printf 'SSH-ARGV-ok\\n'\n"
            "  read -r input\n"
            "fi\n"
        )
        ssh_fixture.chmod(0o700)
        env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
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
                exercise_session_exit(node, env)
            finally:
                agent.terminate()
                agent.wait(timeout=5)


def exercise(node, env):
    version = subprocess.check_output(node + ["--version"], env=env).strip()
    name, number = version.split()
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    original = termios.tcgetattr(slave)
    process = subprocess.Popen(node, env=env, stdin=slave, stdout=slave, stderr=slave)
    try:
        frame = read_until(master, b"ctrl+g Menu")
        assert name + b" v" + number in frame
        assert frame.count(b"v" + number) == 2
        assert b"+ New workspace" in frame
        assert "↗ SSH connect".encode() in frame
        for rows, cols, terminal_cols in [(24, 40, 40), (24, 100, 75)]:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            process.send_signal(signal.SIGWINCH)
            read_until(master, b"\x1b[2J")
            os.write(master, b"stty size\r")
            read_until(master, f"{rows - 2} {terminal_cols}".encode())
        os.write(master, b"printf 'PTY-%s\\n' smoke\r")
        read_until(master, b"PTY-smoke")
        nested = shlex.join([node[0], str(Path(node[1]).resolve())])
        os.write(master, (nested + "\r").encode())
        read_until(master, b"Rucan session commands")

        os.write(master, b"\x07")
        read_until(master, b"U Check for updates")
        os.write(master, b"e")
        data = read_until(master, b"Esc Menu")
        if b"README.md" not in data:
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
        read_until(master, "›1 ◆ tty-test".encode())
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


def exercise_session_exit(node, env):
    palette_hint = b"Option+Space Search" if sys.platform == "darwin" else b"Alt+Space Search"
    def new(name):
        session = json.loads(subprocess.check_output(node + ["new", "/bin/sh"], env=env))
        subprocess.check_output(node + ["rename", session["id"], name], env=env)
        return session["id"]

    first = new("first-shell")
    background = new("middle-shell")
    new("next-shell")
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    process = subprocess.Popen(
        node + ["attach", first], env=env, stdin=slave, stdout=slave, stderr=slave
    )
    try:
        frame = read_until(master, b"ctrl+g Menu")
        assert "›1 ◇ first-shell".encode() in frame
        assert " 3 ◇ next-shell".encode() in frame
        subprocess.check_call(node + ["kill", background], env=env)
        read_until(master, " 2 ◇ next-shell".encode())
        os.write(master, b"exit\r")
        read_until(master, "›1 ◇ next-shell".encode())
        os.write(master, b"printf 'NEXT-%s\\n' ready\r")
        read_until(master, b"NEXT-ready")
        os.write(master, b"exit\r")
        read_until(master, b"No active workspace")
        os.write(master, b"\x1b[<0;3;22M")
        read_until(master, b"Default shell")
        os.write(master, b"\r")
        read_until(master, "›1 ◇ tty-test".encode())
        os.write(master, b"printf 'NEW-%s\\n' ready\r")
        read_until(master, b"NEW-ready")
        os.write(master, b"\x1b ")
        read_until(master, b"Rucan commands")
        os.write(master, b"ssh")
        frame = read_until(master, "ssh▏".encode())
        assert "›  SSH connect".encode() in frame
        os.write(master, b"\x1b")
        read_until(master, palette_hint)
        os.write(master, b"\x1b[24~ ")
        read_until(master, b"Rucan commands")
        os.write(master, b"\x1b")
        read_until(master, palette_hint)
        os.write(master, b"\x1b[<0;3;23M")
        read_until(master, b"Enter Connect")
        os.write(master, b"ops@192.0.2.7")
        read_until(master, b"Host  ops@192.0.2.7")
        os.write(master, b"\r")
        read_until(master, b"SSH-ARGV-ok")
        os.write(master, b"\x07")
        read_until(master, b"P Pin")
        os.write(master, b"d")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    run()
    print("Local TTY smoke passed")
