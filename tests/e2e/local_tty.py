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
            'case "$*" in\n'
            '  "-o StrictHostKeyChecking=ask -- ops@192.0.2.7")\n'
            '    printf "\\033]7;file://host/srv/QA%%20folder\\007SSH-ARGV-ok %s\\n" "$$";;\n'
            '  "-o StrictHostKeyChecking=ask -t -- ops@192.0.2.7 sh -c "*"/srv/QA folder"*)\n'
            '    printf "SSH-CWD-ok %s\\n" "$$";;\n'
            '  *) exit 2;;\n'
            'esac\n'
            'read -r input\n'
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
        assert "BG○".encode() in frame
        assert any(b"tty-test" in row and b"+" in row for row in frame.split(b"\x1b[2K"))
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
    middle = new("middle-shell")
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
        assert "next-shell ✎".encode() in frame
        assert "[+] [×]".encode() in frame
        os.write(master, b"\x1b[<0;17;5M\x1b[<0;17;5m")
        read_until(master, b"Enter Save")
        os.write(master, "다음".encode())
        read_until(master, "다음▏".encode())
        os.write(master, b"\r")
        read_until(master, " 3 ◇ 다음 ✎".encode())
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        assert any(item["name"] == "다음" for item in sessions)
        os.write(master, b"\x1b[<0;11;5M\x1b[<0;11;5m")
        read_until(master, b"Enter Save")
        os.write(master, b"next-shell")
        read_until(master, "next-shell▏".encode())
        os.write(master, b"\r")
        read_until(master, " 3 ◇ next-shell ✎".encode())
        destination = shlex.quote(str(Path(env["XDG_CONFIG_HOME"]) / "project/scoped"))
        os.write(master, f"cd {destination} && printf 'SOURCE-%s\\n' ready\r".encode())
        read_until(master, b"SOURCE-ready")
        choose_action(master, "next-shell")
        read_until(master, "›3 ◇ next-shell".encode())
        os.write(master, b"\x1b[<0;18;3M")
        read_until(master, "›4 ◇ tty-test".encode())
        os.write(master, b"printf 'CLONED-%s\\n' \"${PWD##*/}\"\r")
        read_until(master, b"CLONED-scoped")
        os.write(master, b"\x1b[<0;22;6M\x1b[<0;22;6m")
        read_until(master, b"Close terminal session?")
        os.write(master, b"y")
        read_until(master, "›3 ◇ next-shell".encode())
        choose_action(master, "1")
        read_until(master, "›1 ◇ first-shell".encode())
        os.write(master, b"\x1b[<0;24;4M\x1b[<0;24;4m")
        read_until(master, b"Close terminal session?")
        os.write(master, b"\r")
        read_until(master, PALETTE_HINT)
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        assert any(item["id"] == middle for item in sessions)
        os.write(master, b"\x1b[<0;24;4M\x1b[<0;24;4m")
        read_until(master, b"Close terminal session?")
        os.write(master, b"\x1b[<0;45;9M\x1b[<0;45;9m")
        read_until(master, " 2 ◇ next-shell".encode())
        os.write(master, b"exit\r")
        read_until(master, "›1 ◇ next-shell".encode())
        os.write(master, b"printf 'NEXT-%s\\n' ready\r")
        read_until(master, b"NEXT-ready")
        os.write(master, b"exit\r")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
        process = subprocess.Popen(
            node, env=env, stdin=slave, stdout=slave, stderr=slave
        )
        frame = read_until(master, PALETTE_HINT)
        assert b"\x1b[?1049h" in frame
        assert "›1 ◇ tty-test".encode() in frame
        os.write(master, b"printf 'NEW-%s\\n' ready\r")
        read_until(master, b"NEW-ready")
        os.write(master, b"\x1b ")
        read_until(master, b"Rucan commands")
        os.write(master, b"ssh")
        read_until(master, b"No matching actions")
        os.write(master, b"\x1b")
        read_until(master, PALETTE_HINT)
        subprocess.check_output(
            node + ["new", "ssh", "-o", "StrictHostKeyChecking=ask", "--", "ops@192.0.2.7"],
            env=env,
        )
        read_until(master, " 2 ◇ ssh".encode())
        choose_action(master, "2")
        read_until(master, b"SSH-ARGV-ok")
        choose_action(master, "1")
        read_until(master, "›1 ◇ tty-test".encode())
        os.write(master, b"\x1b[<0;20;4M")
        frame = read_until(master, "›3 ◇ ops@192.0.2".encode())
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        ssh_sessions = [item for item in sessions if item.get("sshTarget") == "ops@192.0.2.7"]
        assert len(ssh_sessions) == 2
        assert len({item["pid"] for item in ssh_sessions}) == 2
        if b"SSH-CWD-ok" not in frame:
            read_until(master, b"SSH-CWD-ok")
        choose_action(master, "Move sidebar to the right")
        read_until(master, b"[2;76H")
        os.write(master, b"\x1b[<0;82;3M")
        read_until(master, "›1 ◇ tty-test".encode())
        os.write(master, b"printf 'RIGHT-%s\\n' ready\r")
        read_until(master, b"RIGHT-ready")
        os.write(master, b"\x1b[<0;91;3M\x1b[<0;91;3m")
        read_until(master, b"Enter Save")
        os.write(master, b"\x1b")
        read_until(master, PALETTE_HINT)
        os.write(master, b"\x1b[<0;76;3M")
        frame = read_until(master, "┃".encode())
        assert b"\x1b]22;ew-resize\x1b\\" in frame
        os.write(master, b"\x1b[<32;71;3M")
        read_until(master, b"[2;71H")
        os.write(master, b"\x1b[<0;71;3m")
        read_until(master, b"\x1b]22;\x1b\\")
        os.write(master, b"\x1b[<0;100;5M\x1b[<0;100;5m")
        read_until(master, b"Close terminal session?")
        os.write(master, b"\x1b")
        read_until(master, PALETTE_HINT)
        choose_action(master, "Move sidebar to the left")
        read_until(master, b"WORKSPACES")
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
