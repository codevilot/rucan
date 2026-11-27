"""Exercise the compiled local workspace against real PTYs and Vim."""
import base64
import fcntl
import hashlib
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

PALETTE_KEY = b"\x1b " if sys.platform == "darwin" else b"\x1b[32;3u"


def choose_action(master, query):
    os.write(master, PALETTE_KEY)
    read_until(master, b"Rucan commands")
    os.write(master, query.encode())
    read_until(master, f"{query}▏".encode())
    os.write(master, b"\r")


def exercise_ssh_directory_report(path):
    home = path / "ssh-home"
    project = home / "QA project's 100%"
    project.mkdir(parents=True)
    (home / ".bashrc").write_text("PS1='DIR-PROMPT> '; PROMPT_COMMAND='printf USER-PROMPT\\n'\n")
    command = subprocess.check_output([
        "node", "--input-type=module", "-e",
        "import { sshShellCommand } from './apps/cli/dist/terminal/ssh-directory-report.js'; "
        "process.stdout.write(sshShellCommand(process.argv[1]));",
        str(home),
    ]).decode()
    master, slave = pty.openpty()
    process = subprocess.Popen(
        ["/bin/sh", "-c", command],
        env=dict(os.environ, HOME=str(home), SHELL="/bin/bash", SSH_CONNECTION="192.0.2.1 12345 192.0.2.7 22"),
        stdin=slave, stdout=slave, stderr=slave,
    )
    try:
        def report(directory):
            uri = "/".join("".join(f"%{byte:02x}" for byte in part.encode()) for part in str(directory).split("/"))
            return f"\x1b]7;file://192.0.2.7{uri}\x07".encode()

        startup = read_until(master, b"DIR-PROMPT> ")
        assert report(home) in startup and b"USER-PROMPT" in startup
        os.write(master, f"cd {shlex.quote(str(project))}\r".encode())
        read_until(master, report(project))
        os.write(master, b"exit\r")
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)


def run():
    with tempfile.TemporaryDirectory(prefix="rucan-e2e-") as sandbox:
        path = Path(sandbox)
        path.chmod(0o700)
        exercise_ssh_directory_report(path)
        env = dict(os.environ, TERM="xterm-256color", XDG_CONFIG_HOME=sandbox)
        env.pop("RUCAN_SESSION_ID", None)
        env["XDG_CACHE_HOME"] = str(path / "cache")
        env["RUCAN_AGENT_SOCKET"] = str(path / "agent.sock")
        env["RUCAN_AGENT_BINARY"] = str(Path("target/debug/rucan-agent").resolve())
        bin_dir = path / "bin"
        bin_dir.mkdir()
        foreground_dir = path / "foreground"
        foreground_dir.mkdir()
        foreground_source = foreground_dir / "ssh.c"
        foreground_source.write_text(
            '#include <stdio.h>\nint main(void) {\n'
            '  puts("FOREGROUND-SSH-ready"); fflush(stdout);\n'
            '  while (getchar() != EOF) {}\n  return 0;\n}\n'
        )
        subprocess.check_call(["cc", str(foreground_source), "-o", str(foreground_dir / "ssh")])
        ssh_login = bin_dir / "ssh-login"
        ssh_login.write_text('#!/bin/sh\nprintf "SSH-CWD-ok %s\\n" "$$"\nread -r input\n')
        ssh_login.chmod(0o700)
        ssh_fixture = bin_dir / "ssh"
        ssh_fixture.write_text(
            '#!/bin/sh\n'
            'shared=no\n'
            'case "$*" in\n'
            '  "-o ControlMaster=auto -o ControlPersist=60 -o ControlPath=/tmp/rucan-ssh-"*"/%C -o StrictHostKeyChecking=ask "*) shared=yes; shift 6;;\n'
            'esac\n'
            'case "$*" in\n'
            '  "-o StrictHostKeyChecking=ask -t -- ops@192.0.2.7 sh -c "*"/srv/QA folder"*)\n'
            '    [ "$shared" = yes ] || exit 2\n'
            '    exec env SHELL="${0%/*}/ssh-login" /bin/sh -c "$6";;\n'
            '  "ops@192.0.2.7" | "-o StrictHostKeyChecking=ask -t -- ops@192.0.2.7 sh -c "*)\n'
            '    [ "$#" -eq 1 ] || [ "$shared" = yes ] || exit 2\n'
            '    printf "\\033]7;file://host/srv/QA%%20folder\\007SSH-ARGV-ok %s\\n" "$$";;\n'
            '  "-o StrictHostKeyChecking=ask -t -- saved-fixture sh -c "*)\n'
            '    [ "$shared" = yes ] || exit 2\n'
            '    printf "\\033]7;file://192.0.2.88/srv/demo\\007SSH-ALIAS-ready\\n";;\n'
            '  *) exit 2;;\n'
            'esac\n'
            'read -r input\n'
        )
        ssh_fixture.chmod(0o700)
        editor = bin_dir / "vi"
        editor.write_text(
            '#!/bin/sh\nfor file do :; done\n[ -f "$file" ] || exit 2\n'
            'printf "SSH-CONFIG-editor\\n"\n'
            'read -r input\n'
            'if [ "$input" = save ]; then printf "Host updated-fixture\\n" >> "$file"; fi\n'
        )
        editor.chmod(0o700)
        opener = bin_dir / ("open" if sys.platform == "darwin" else "xdg-open")
        opener.write_text('#!/bin/sh\n[ "$#" -eq 1 ] || exit 2\nprintf "%s\\n" "$1" > "$XDG_CONFIG_HOME/opened-file"\n')
        opener.chmod(0o700)
        clipboard = bin_dir / "pbcopy"
        clipboard.write_text('#!/bin/sh\ncat > "$XDG_CONFIG_HOME/copied-text"\n')
        clipboard.chmod(0o700)
        env["PATH"] = f"{bin_dir}{os.pathsep}{env['PATH']}"
        node = ["node", str(Path("apps/cli/dist/main.js").resolve())]
        config_dir = path / "rucan"
        config_dir.mkdir(mode=0o700)
        project = path / "project"
        project.mkdir()
        (project / "outside.txt").write_text("Outside the selected directory\n")
        (project / "scoped").mkdir()
        (project / "scoped" / "README.md").write_text("RUCAN-FILE-PREVIEW\n")
        (project / "scoped" / "video clip.MP4").write_bytes(b"\x00video fixture")
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
                exercise_split_panes(node, env)
                exercise_workspace_launcher(node, env, path)
                exercise_session_exit(node, env)
                exercise_location_name(node, env, project)
                exercise_ssh_retry(path)
                exercise_agent_recovery(node, env, agent)
                exercise_large_paste(node, env)
            finally:
                agent.terminate()
                agent.wait(timeout=5)


def exercise_large_paste(node, env):
    repeated = "Large paste — 한글 🙂\n".encode()
    payload = repeated * 22000
    digest = hashlib.sha256(payload).hexdigest()
    session = json.loads(subprocess.check_output(node + ["new", "/bin/sh"], env=env))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    process = subprocess.Popen(
        node + ["attach", session["id"]], env=env, stdin=slave, stdout=slave, stderr=slave,
    )
    try:
        read_until(master, PALETTE_HINT)
        os.write(master, b"printf '\\033[?1002h\\033[?1006h\\033[2J\\033[HSELECT-%s\\n' demo\r")
        read_until(master, b"SELECT-demo")
        os.write(master, b"\x1b[<0;26;2M\x1b[<32;36;2M\x1b[<0;36;2m")
        if sys.platform != "darwin":
            read_until(master, b"\x1b]52;c;" + base64.b64encode(b"SELECT-demo"))
        read_until(master, b"Copied terminal text")
        if sys.platform == "darwin":
            assert (Path(env["XDG_CONFIG_HOME"]) / "copied-text").read_bytes() == b"SELECT-demo"
        os.write(master, b"printf '\\033[?1002l\\033[?1006l'\r")
        reader = f"import hashlib, sys; print('\\rPASTE-' + hashlib.sha256(sys.stdin.buffer.read({len(payload)})).hexdigest())"
        command = f"stty raw -echo; printf 'PASTE-%s\\n' ready; sleep 0.5; python3 -c {shlex.quote(reader)}; stty sane"
        os.write(master, (command + "\r").encode())
        read_until(master, b"PASTE-ready")
        started = time.monotonic()
        os.set_blocking(master, False)
        data = memoryview(b"\x1b[200~" + payload + b"\x1b[201~")
        output = b""
        while data:
            if time.monotonic() - started >= 15:
                raise AssertionError("Large paste did not reach the PTY")
            readable, writable, _ = select.select([master], [master], [], 0.1)
            if readable:
                output = (output + os.read(master, 65536))[-4096:]
            if writable:
                try:
                    data = data[os.write(master, data[:65536]):]
                except BlockingIOError:
                    pass
        os.set_blocking(master, True)
        marker = ("PASTE-" + digest).encode()
        if marker not in output:
            read_until(master, marker)
        print(f"Verified {len(payload)} pasted bytes in {time.monotonic() - started:.2f}s")
        choose_action(master, "Close UI")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
        subprocess.check_call(node + ["kill", session["id"]], env=env)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)


def exercise_agent_recovery(node, env, agent):
    session = json.loads(subprocess.check_output(node + ["new", "/bin/sh"], env=env))
    recovery_target = json.loads(subprocess.check_output(node + ["new", "/bin/sh"], env=env))
    for item, name in ((session, "recovery-main"), (recovery_target, "recovery-target")):
        subprocess.check_output(node + ["rename", item["id"], name], env=env)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    process = subprocess.Popen(
        node + ["attach", session["id"]], env=env, stdin=slave, stdout=slave, stderr=slave,
    )
    try:
        read_until(master, PALETTE_HINT)
        choose_action(master, "Select terminal text")
        read_until(master, b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l")
        choose_action(master, "Resume mouse controls")
        read_until(master, b"\x1b[?1006h\x1b[?1002h")
        os.write(master, b"saved=alive; printf 'BEFORE-%s\\n' \"$saved\"\r")
        read_until(master, b"BEFORE-alive")
        agent.send_signal(signal.SIGSTOP)
        read_until(master, b"Agent unavailable", seconds=18)
        os.write(master, b"offline=replayed\r")
        choose_action(master, "recovery-target")
        read_until(master, b"Workspace switch queued")
        agent.send_signal(signal.SIGCONT)
        read_until(master, b"recovery-target", seconds=25)
        choose_action(master, "recovery-main")
        read_until(master, b"recovery-main")
        os.write(master, b"printf 'AFTER-%s-%s\\n' \"$saved\" \"${offline:-clear}\"\r")
        read_until(master, b"AFTER-alive-clear")
        verify_read_only_recovers(node, env, session["id"], process, master)
        for item in (session, recovery_target):
            subprocess.check_call(node + ["kill", item["id"]], env=env)
    finally:
        agent.send_signal(signal.SIGCONT)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)


def verify_read_only_recovers(node, env, session_id, controller, controller_pty):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    viewer = subprocess.Popen(
        node + ["attach", session_id], env=env, stdin=slave, stdout=slave, stderr=slave,
    )
    try:
        read_until(master, b"waiting for the other client to release input")
        choose_action(controller_pty, "Close UI")
        read_until(controller_pty, b"\x1b[?1049l")
        assert controller.wait(timeout=5) == 0
        read_until(master, b"Local agent connected")
        os.write(master, b"printf 'LEASE-%s\\n' \"$saved\"\r")
        read_until(master, b"LEASE-alive")
        choose_action(master, "Close UI")
        read_until(master, b"\x1b[?1049l")
        assert viewer.wait(timeout=5) == 0
    finally:
        if viewer.poll() is None:
            viewer.kill()
            viewer.wait(timeout=5)
        os.close(master)
        os.close(slave)


def exercise_location_name(node, env, project):
    session = json.loads(subprocess.check_output(
        node + ["new", "/bin/sh"], env=env, cwd=project,
    ))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 160, 0, 0))
    process = subprocess.Popen(
        node + ["attach", session["id"]], env=env, stdin=slave, stdout=slave, stderr=slave,
    )
    try:
        read_until(master, b"localhost / project")
        os.write(master, b"cd scoped\r")
        read_until(master, b"localhost / scoped")
        choose_action(master, "Rename workspace")
        read_until(master, "localhost / scoped▏".encode())
        os.write(master, b"sh")
        read_until(master, "sh▏".encode())
        os.write(master, b"\r")
        read_until(master, "◇ sh ✎".encode())
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        updated = next(entry for entry in sessions if entry["id"] == session["id"])
        assert updated["name"] == "sh" and updated["customName"]
        os.write(master, b"\x1b")
        read_until(master, PALETTE_HINT)
        choose_action(master, "Rename workspace")
        read_until(master, "sh▏".encode())
        os.write(master, b"\x7f")
        read_until(master, " ▏".encode())
        os.write(master, b"\r")
        read_until(master, b"localhost / scoped")
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        restored = next(entry for entry in sessions if entry["id"] == session["id"])
        assert restored["name"] == "sh" and not restored["customName"]
        os.write(master, b"\x1b")
        read_until(master, PALETTE_HINT)
        choose_action(master, "Close UI")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
        subprocess.check_call(node + ["kill", session["id"]], env=env)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)


def exercise_workspace_launcher(node, env, path):
    home = path / "launcher-home"
    (home / ".ssh").mkdir(parents=True)
    (home / ".ssh/config").write_text("Host saved-fixture\n  HostName example.invalid\n")
    client_env = dict(env, HOME=str(home))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    process = subprocess.Popen(node, env=client_env, stdin=slave, stdout=slave, stderr=slave)
    try:
        read_until(master, PALETTE_HINT)
        os.write(master, b"\x1b[<0;7;4M\x1b[<0;7;4m")
        read_until(master, "›  localhost".encode())
        os.write(master, b"\x1b[<0;5;3M\x1b[<0;5;3m")
        read_until(master, PALETTE_HINT)
        os.write(master, b"\x1b[<0;7;4M\x1b[<0;7;4m")
        read_until(master, "›  localhost".encode())
        os.write(master, b"\r")
        read_until(master, "›2 ◇ loc… / proj".encode())
        os.write(master, b"\x1b[<0;7;5M\x1b[<0;7;5m")
        read_until(master, "SSH · saved-fixture".encode())
        os.write(master, b"saved-fixture")
        read_until(master, "saved-fixture▏".encode())
        os.write(master, b"\r")
        read_until(master, b"SSH-ALIAS-ready")
        os.write(master, b"\x1b[<0;7;6M\x1b[<0;7;6m")
        read_until(master, b"Edit SSH config")
        os.write(master, b"\x1b[<0;45;9M\x1b[<0;45;9m")
        read_until(master, b"SSH-CONFIG-editor")
        os.write(master, b"save\r")
        read_until(master, "›3 ◇ 192… / demo".encode())
        os.write(master, b"\x1b[<0;7;6M\x1b[<0;7;6m")
        read_until(master, "SSH · updated-fixture".encode())
        os.write(master, b"\x1b")
        read_until(master, PALETTE_HINT)
        choose_action(master, "Edit SSH config")
        read_until(master, b"SSH-CONFIG-editor")
        os.write(master, b"exit\r")
        read_until(master, "›3 ◇ 192… / demo".encode())
        choose_action(master, "new session")
        read_until(master, "›  localhost".encode())
        os.write(master, b"\r")
        read_until(master, "›4 ◇ loc… / proj".encode())
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        running = [entry for entry in sessions if entry["state"]["type"] == "running"]
        assert sum(entry.get("sshTarget") == "saved-fixture" for entry in running) == 1
        assert sum(entry["name"] == "tty-test" and not entry.get("sshTarget") for entry in running) == 3
        choose_action(master, "Close UI")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        for session in sessions:
            if session["state"]["type"] == "running":
                subprocess.check_output(node + ["kill", session["id"]], env=env)


def exercise_ssh_retry(path):
    retry_bin = path / "retry-bin"
    retry_bin.mkdir()
    ssh = retry_bin / "ssh"
    ssh.write_text('#!/bin/sh\nprintf "SSH-RETRY-attempt\\n"\nexit 255\n')
    ssh.chmod(0o700)
    env = dict(os.environ, PATH=f"{retry_bin}{os.pathsep}{os.environ['PATH']}")
    pid, master = pty.fork()
    if pid == 0:
        os.execvpe("node", ["node", "apps/cli/dist/terminal/ssh-reconnect-runner.js", "fixture"], env)
    reaped = False
    try:
        read_until(master, b"Reconnecting in 4s")
        os.write(master, b"\r")
        frame = read_until(master, b"SSH-RETRY-attempt", seconds=2)
        if b"Reconnecting in 8s" not in frame:
            read_until(master, b"Reconnecting in 8s")
        os.write(master, b"\x03")
        for _ in range(100):
            ended, status = os.waitpid(pid, os.WNOHANG)
            if ended:
                reaped = True
                assert os.waitstatus_to_exitcode(status) == 0
                break
            time.sleep(.025)
        assert reaped, "SSH retry did not stop after Ctrl+C"
    finally:
        if not reaped:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(master)


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
        assert any("loc… / proj".encode() in row and b"+" in row for row in frame.split(b"\x1b[2K"))
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
        os.write(master, b"\x1b[B")
        read_until(master, b"Open in default app")
        os.write(master, b"v")
        opened = Path(env["XDG_CONFIG_HOME"]) / "opened-file"
        for _ in range(100):
            if opened.exists() and opened.read_text():
                break
            time.sleep(0.025)
        assert Path(opened.read_text().strip()) == (
            Path(env["XDG_CONFIG_HOME"]) / "project/scoped/video clip.MP4"
        ).resolve()
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

        for label in ("›1 ◆ loc… / scop", "›1 ◇ loc… / scop", "›1 ◆ loc… / scop"):
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


def exercise_split_panes(node, env):
    sessions = []

    def new(name):
        session = json.loads(subprocess.check_output(node + ["new", "/bin/sh"], env=env))
        sessions.append(session["id"])
        subprocess.check_output(node + ["rename", session["id"], name], env=env)
        return session

    def mouse(button, col, row, release=False):
        os.write(master, f"\x1b[<{button};{col};{row}{'m' if release else 'M'}".encode())

    def click(col, row):
        mouse(0, col, row)
        mouse(0, col, row, release=True)

    def hover(col, row, preview_col, preview_row):
        mouse(32, col, row)
        frame = read_until(master, b"Drop here")
        assert any(
            f"\x1b[{preview_row};{preview_col}H".encode() in line and b"Drop here" in line
            for line in frame.split(b"\x1b[2K")
        )

    master, slave = pty.openpty()
    process = None
    try:
        first = new("first-pane")
        middle = new("middle-pane")
        new("next-pane")
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
        process = subprocess.Popen(
            node + ["attach", first["id"]], env=env, stdin=slave, stdout=slave, stderr=slave
        )
        frame = read_until(master, PALETTE_HINT)
        assert "›1 ◇ first-pane".encode() in frame
        assert " 3 ◇ next-pane".encode() in frame

        mouse(0, 2, 5)
        hover(28, 12, 26, 13)
        hover(97, 12, 64, 13)
        mouse(0, 97, 12, release=True)
        read_until(master, "next-pane".encode())
        mouse(0, 2, 4)
        hover(80, 22, 64, 19)
        mouse(0, 80, 22, release=True)
        read_until(master, "middle-pane".encode())

        click(40, 2)
        read_until(master, "›1 ◇ first-pane".encode())
        os.write(master, b"pane_token=first; (sleep 1; printf 'BACKGROUND-%s\\n' kept) &\r")
        click(80, 14)
        frame = read_until(master, "›2 ◇ middle-pane".encode())
        os.write(master, b"pane_token=middle; printf 'FOCUSED-%s\\n' \"$pane_token\"\r")
        frame += read_until(master, b"FOCUSED-middle")
        if b"BACKGROUND-kept" not in frame:
            read_until(master, b"BACKGROUND-kept")

        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 24, 0, 0))
        process.send_signal(signal.SIGWINCH)
        frame = read_until(master, b"\x1b[2J").split(b"\x1b[2J", 1)[1]
        os.write(master, b"stty size; printf 'NARROW-%s\\n' \"$pane_token\"\r")
        frame += read_until(master, b"NARROW-middle")
        assert b"22 24" in frame
        assert b"next-pane" not in frame and b"first-pane" not in frame

        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
        process.send_signal(signal.SIGWINCH)
        frame = read_until(master, b"\x1b[14;64H")
        assert b"first-pane" in frame and b"next-pane" in frame

        mouse(0, 63, 7)
        mouse(32, 55, 7)
        mouse(0, 55, 7, release=True)
        click(40, 2)
        read_until(master, "›1 ◇ first-pane".encode())
        os.write(master, b"stty size; printf 'FOCUSED-%s\\n' \"$pane_token\"\r")
        frame = read_until(master, b"FOCUSED-first")
        assert b"21 29" in frame

        click(100, 14)
        os.write(master, b"printf 'AFTER-CLOSE-%s\\n' \"$pane_token\"\r")
        read_until(master, b"AFTER-CLOSE-first")
        inventory = json.loads(subprocess.check_output(node + ["ls"], env=env))
        detached = next(item for item in inventory if item["id"] == middle["id"])
        assert detached["pid"] == middle["pid"]
        assert detached["state"]["type"] == "running"

        mouse(0, 2, 4)
        hover(29, 12, 26, 13)
        mouse(0, 29, 12, release=True)
        read_until(master, "middle-pane".encode())
        click(30, 2)
        os.write(master, b"printf 'BACK-%s\\n' \"$pane_token\"\r")
        read_until(master, b"BACK-middle")
        choose_action(master, "Close UI")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)
        for session in sessions:
            subprocess.run(
                node + ["kill", session], env=env, check=False,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )


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
        frame = read_until(master, b"Enter Save")
        assert b"Rename workspace" in frame and "next-shell▏".encode() in frame
        os.write(master, b"discard-me")
        read_until(master, "discard-me▏".encode())
        os.write(master, b"\x1b[<0;18;3M\x1b[<0;18;3m")
        read_until(master, PALETTE_HINT)
        os.write(master, b"\x1b[<0;17;5M\x1b[<0;17;5m")
        frame = read_until(master, b"Enter Save")
        assert "next-shell▏".encode() in frame
        os.write(master, "다음".encode())
        read_until(master, "다음▏".encode())
        os.write(master, b"\x1b[<0;45;9M\x1b[<0;45;9m")
        read_until(master, " 3 ◇ 다음 ✎".encode())
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        assert any(item["name"] == "다음" for item in sessions)
        os.write(master, b"\x1b[<0;11;5M\x1b[<0;11;5m")
        frame = read_until(master, b"Enter Save")
        assert b"Rename workspace" in frame and "다음▏".encode() in frame
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
        read_until(master, "›4 ◇ loc… / scop".encode())
        os.write(master, b"printf 'CLONED-%s\\n' \"${PWD##*/}\"\r")
        read_until(master, b"CLONED-scoped")
        os.write(master, b"\x1b[<0;22;6M\x1b[<0;22;6m")
        read_until(master, b"Close terminal session?")
        os.write(master, b"\x1b[<0;18;3M\x1b[<0;18;3m")
        read_until(master, PALETTE_HINT)
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
        assert "›1 ◇ loc… / proj".encode() in frame
        os.write(master, b"printf 'NEW-%s\\n' ready\r")
        read_until(master, b"NEW-ready")
        foreground = shlex.quote(str(Path(env["XDG_CONFIG_HOME"]) / "foreground/ssh"))
        os.write(master, f"PS1='RUCAN-LOCAL> '; {foreground} ops@192.0.2.7\r".encode())
        read_until(master, b"FOREGROUND-SSH-ready")
        os.write(master, b"\x1b[<0;20;3M")
        read_until(master, b"SSH-ARGV-ok")
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        clone = next(item for item in sessions if item.get("sshTarget") == "ops@192.0.2.7" and item["state"]["type"] == "running")
        subprocess.check_call(node + ["kill", clone["id"]], env=env)
        read_until(master, "›1 ◇ 192.0.2.7".encode())
        os.write(master, b"\x03")
        read_until(master, b"RUCAN-LOCAL>")
        os.write(master, b"printf 'LOCAL-%s\\n' restored\r")
        read_until(master, b"LOCAL-restored")
        os.write(master, PALETTE_KEY)
        read_until(master, b"Rucan commands")
        os.write(master, b"ssh")
        read_until(master, b"SSH connect")
        os.write(master, b"\x1b")
        read_until(master, PALETTE_HINT)
        subprocess.check_output(
            node + ["new", "ssh", "ops@192.0.2.7"],
            env=env,
        )
        read_until(master, " 2 ◇ 192".encode())
        choose_action(master, "2")
        read_until(master, b"SSH-ARGV-ok")
        choose_action(master, "1")
        read_until(master, "›1 ◇ loc… / proj".encode())
        os.write(master, b"\x1b[<0;20;4M")
        frame = read_until(master, "›3 ◇ 19".encode())
        sessions = json.loads(subprocess.check_output(node + ["ls"], env=env))
        ssh_sessions = [item for item in sessions if item.get("sshTarget") == "ops@192.0.2.7" and item["state"]["type"] == "running"]
        assert len(ssh_sessions) == 2
        assert len({item["pid"] for item in ssh_sessions}) == 2
        if b"SSH-CWD-ok" not in frame:
            read_until(master, b"SSH-CWD-ok")
        choose_action(master, "Move sidebar to the right")
        read_until(master, b"[2;76H")
        os.write(master, b"\x1b[<0;82;3M")
        read_until(master, "›1 ◇ loc… / proj".encode())
        os.write(master, b"printf 'RIGHT-%s\\n' ready\r")
        read_until(master, b"RIGHT-ready")
        os.write(master, b"\x1b[<0;93;3M\x1b[<0;93;3m")
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
