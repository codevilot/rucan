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


PALETTE_HINT = b"Option+Space Palette" if sys.platform == "darwin" else b"Alt+Space Palette"


def choose_action(master, query):
    os.write(master, b"\x1b ")
    read_until(master, b"Rucan commands")
    os.write(master, query.encode())
    read_until(master, f"{query}▏".encode())
    os.write(master, b"\r")


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
            '  printf "SSH-ARGV-ok %s\\n" "$$"\n'
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
        (project / "outside.txt").write_text("Outside the selected directory\n")
        (project / "scoped").mkdir()
        (project / "scoped" / "README.md").write_text("RUCAN-FILE-PREVIEW\n")
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
        frame = read_until(master, PALETTE_HINT)
        assert name + b" v" + number in frame
        assert frame.count(b"v" + number) == 2
        assert "BG○ +".encode() in frame
        for rows, cols, terminal_cols in [(24, 40, 40), (24, 100, 75)]:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
            process.send_signal(signal.SIGWINCH)
            read_until(master, b"\x1b[2J")
            os.write(master, b"stty size\r")
            read_until(master, f"{rows - 2} {terminal_cols}".encode())
        exercise_sidebar(master)
        os.write(master, b"printf 'PTY-%s\\n' smoke\r")
        read_until(master, b"PTY-smoke")
        nested = shlex.join([node[0], str(Path(node[1]).resolve())])
        os.write(master, (nested + "\r").encode())
        read_until(master, b"Rucan session commands")

        os.write(master, b"cd scoped && printf 'CWD-%s\\n' ready\r")
        read_until(master, b"CWD-ready")
        choose_action(master, "Browse files")
        data = read_until(master, b"Esc Palette")
        if b"README.md" not in data:
            data = read_until(master, b"README.md")
        assert b"outside.txt" not in data
        os.write(master, b"\r")
        read_until(master, b"RUCAN-FILE-PREVIEW")
        os.write(master, b"\x1b")
        read_until(master, b"Rucan commands")
        os.write(master, b"\x1b")
        read_until(master, PALETTE_HINT)

        os.write(master, b"vim -Nu NONE -i NONE -n\r")
        read_until(master, b"VIM - Vi IMproved")
        os.write(master, b"iFrom-Vim")
        read_until(master, b"From-Vim")
        os.write(master, b"\x1b:q!\r")
        time.sleep(0.15)

        for label in ("›1 ◆ tty-test", "›1 ◇ tty-test", "›1 ◆ tty-test"):
            os.write(master, b"\x1b[<0;20;2M")
            read_until(master, label.encode())
        choose_action(master, "exit")
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


def exercise_sidebar(master):
    def expect_width(width):
        os.write(master, b"stty size\r")
        read_until(master, f"22 {width}".encode())

    def drag(source, destination):
        os.write(master, (
            f"\x1b[<0;{source};6M\x1b[<32;{destination};6M\x1b[<0;{destination};6m"
        ).encode())

    drag(25, 40)
    expect_width(60)
    for action, width in (("Hide sidebar", 100), ("Show sidebar", 60)):
        choose_action(master, action)
        read_until(master, PALETTE_HINT)
        expect_width(width)
    drag(40, 25)
    expect_width(75)


def exercise_session_exit(node, env):
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
        frame = read_until(master, PALETTE_HINT)
        assert "›1 ◇ first-shell".encode() in frame
        assert " 3 ◇ next-shell".encode() in frame
        choose_action(master, "next-shell")
        read_until(master, "›3 ◇ next-shell".encode())
        choose_action(master, "1")
        read_until(master, "›1 ◇ first-shell".encode())
        subprocess.check_call(node + ["kill", background], env=env)
        read_until(master, " 2 ◇ next-shell".encode())
        os.write(master, b"exit\r")
        read_until(master, "›1 ◇ next-shell".encode())
        os.write(master, b"printf 'NEXT-%s\\n' ready\r")
        read_until(master, b"NEXT-ready")
        os.write(master, b"exit\r")
        read_until(master, b"No active workspace")
        os.write(master, b"\x1b[<0;24;2M")
        read_until(master, "›1 ◇ tty-test".encode())
        os.write(master, b"printf 'NEW-%s\\n' ready\r")
        read_until(master, b"NEW-ready")
        os.write(master, b"\x1b ")
        read_until(master, b"Rucan commands")
        os.write(master, b"ssh")
        frame = read_until(master, "ssh▏".encode())
        assert "›  SSH connect".encode() in frame
        os.write(master, b"\x1b")
        read_until(master, PALETTE_HINT)
        os.write(master, b"\x1b[<0;3;24M")
        read_until(master, b"Rucan commands")
        os.write(master, b"\x1b[<0;24;2M\x1b[<0;24;2m")
        os.write(master, b"ssh")
        read_until(master, "ssh▏".encode())
        os.write(master, b"\x1b[<0;45;8M\x1b[<0;45;8m")
        read_until(master, b"Enter Connect")
        os.write(master, b"ops@192.0.2.7")
        read_until(master, b"Host  ops@192.0.2.7")
        os.write(master, b"\r")
        read_until(master, b"SSH-ARGV-ok")
        os.write(master, b"\x1b[<0;24;2M")
        frame = read_until(master, "›3 ◇ ops@192.0.2.7".encode())
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        ssh_sessions = [item for item in sessions if item.get("sshTarget") == "ops@192.0.2.7"]
        assert len(ssh_sessions) == 2
        assert len({item["pid"] for item in ssh_sessions}) == 2
        if b"SSH-ARGV-ok" not in frame:
            read_until(master, b"SSH-ARGV-ok")
        choose_action(master, "Close UI")
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
