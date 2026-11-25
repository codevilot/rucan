"""Verify offline agent transfer and SSH reconnect with independent clients."""
import hashlib
import json
import os
from pathlib import Path
import pty
import signal
import sys
import struct
import subprocess
import tempfile
import time
import termios
import fcntl

from local_tty import choose_action, read_until

NODE = ["node", "apps/cli/dist/main.js"]
HOST = "rucan-offline-e2e"


def output(command, env=None):
    return subprocess.check_output(command, env=env, text=True, timeout=45).strip()


def shell(env, script):
    return output(["ssh", "-F", env["RUCAN_SSH_CONFIG"], HOST, script], env)


def environment(root, client, container, host_key):
    key = root / f"{client}-key"
    subprocess.check_call(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", key])
    known = root / f"{client}-known"
    known.write_text(f"{HOST} {host_key}\n")
    config = root / f"{client}-ssh"
    config.write_text(
        f"Host {HOST}\n  HostKeyAlias {HOST}\n  User rucan\n"
        f"  ProxyCommand docker exec -i {container} nc 127.0.0.1 22\n"
        f"  IdentityFile {key}\n  IdentitiesOnly yes\n  StrictHostKeyChecking yes\n"
        f"  UserKnownHostsFile {known}\n  ControlMaster no\n  BatchMode yes\n"
    )
    return (
        dict(os.environ, RUCAN_SSH_CONFIG=str(config), XDG_CONFIG_HOME=str(root / client), XDG_CACHE_HOME=str(root / client / "cache"),
             TERM="xterm-256color"),
        key.with_suffix(".pub").read_bytes(),
    )


def start_terminal(env, session, command=None):
    master, slave = pty.openpty()
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
        process = subprocess.Popen(
            NODE + (command or ["attach", f"{HOST}:{session}"]), stdin=slave, stdout=slave,
            stderr=slave, env=env, start_new_session=True,
        )
    finally:
        os.close(slave)
    return master, process


def stop_terminal(master, process, signum):
    try:
        if process.poll() is None:
            os.killpg(process.pid, signum)
            process.wait(timeout=10)
    finally:
        os.close(master)


def exercise_tmux(env):
    shell(env, "tmux new-session -d -s outside-rucan -c /tmp")
    listing = json.loads(output(NODE + ["tmux", "ls", "--host", HOST], env))
    assert listing["available"] and [item["name"] for item in listing["sessions"]] == ["outside-rucan"], (listing, shell(env, 'tmux list-sessions -F "#{session_id}|#{session_name}|#{session_path}"'))
    master, process = start_terminal(env, None, ["tmux", "open", "--host", HOST, "outside-rucan"])
    try:
        read_until(master, b"outside-rucan")
        os.write(master, b"printf 'TMUX-%s\\n' attached\r")
        read_until(master, b"TMUX-attached")
        choose_action(master, "Quit Rucan")
        read_until(master, b"3  Stop all Rucan-managed sessions")
        os.write(master, b"3")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
    finally:
        stop_terminal(master, process, signal.SIGTERM)
    assert shell(env, "tmux has-session -t outside-rucan && printf preserved") == "preserved"
    inventory = json.loads(output(NODE + ["ls", "--host", HOST], env))
    external = next(item for item in inventory if item["name"] == "outside-rucan")
    failed = subprocess.run(NODE + ["kill", "--host", HOST, external["id"]], env=env, capture_output=True, text=True, check=False)
    assert failed.returncode and "externally owned tmux" in failed.stderr


def run(root, container, artifact, with_tmux):
    host_key = None
    for _ in range(30):
        attempt = subprocess.run(
            ["docker", "exec", container, "cat", "/etc/ssh/ssh_host_ed25519_key.pub"],
            capture_output=True, text=True, check=False,
        )
        if attempt.returncode == 0:
            host_key = " ".join(attempt.stdout.split()[:2])
            break
        time.sleep(0.2)
    assert host_key, "the test SSH host key was never generated"
    first, first_key = environment(root, "client-a", container, host_key)
    second, second_key = environment(root, "client-c", container, host_key)
    subprocess.run(
        ["docker", "exec", "-i", container, "sh", "-c",
         "cat > /home/rucan/.ssh/authorized_keys && chmod 600 /home/rucan/.ssh/authorized_keys"
         " && chown rucan:rucan /home/rucan/.ssh/authorized_keys"],
        input=first_key + second_key, check=True,
    )
    assert shell(first, 'for tool in node npm rustc cargo; do ! command -v "$tool" || exit 1; done; printf offline') == "offline"
    if not with_tmux:
        assert shell(first, "! command -v tmux && printf absent") == "absent"
    unsigned = subprocess.run(
        NODE + ["remote", "install", HOST, str(artifact), "0" * 64],
        env=first, capture_output=True, text=True, timeout=15, check=False,
    )
    assert unsigned.returncode and "SHA-256 mismatch" in unsigned.stderr
    digest = hashlib.sha256(artifact.read_bytes()).hexdigest()
    print(output(NODE + ["remote", "install", HOST, str(artifact), digest], first), flush=True)
    if with_tmux:
        exercise_tmux(first)
        return
    worker = 'echo RUNNING; while :; do echo tick >> "$HOME/ticks"; sleep .2; done'
    created = json.loads(output(NODE + ["new", "--host", HOST, "/bin/sh", "-c", worker], first))
    session = created["id"]

    master, process = start_terminal(first, session)
    try:
        read_until(master, b"RUNNING")
        choose_action(master, "Pin workspace")
        read_until(master, "›1 ◆".encode())
    finally:
        stop_terminal(master, process, signal.SIGKILL)

    before = int(shell(second, 'wc -l < "$HOME/ticks"'))
    time.sleep(1)
    assert int(shell(second, 'wc -l < "$HOME/ticks"')) > before
    inventory = json.loads(output(NODE + ["ls", "--host", HOST], second))
    assert len(inventory) == 1
    assert inventory[0]["pid"] == created["pid"] and inventory[0]["id"] == session
    assert inventory[0]["persistent"] and inventory[0]["state"]["type"] == "running"

    master, process = start_terminal(second, session)
    try:
        read_until(master, b"RUNNING")
        choose_action(master, "Close UI")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
    finally:
        stop_terminal(master, process, signal.SIGTERM)
    print(output(NODE + ["kill", "--host", HOST, session], second), flush=True)


if __name__ == "__main__":
    with_tmux = "--tmux" in sys.argv
    image = "rucan-e2e-tmux:local" if with_tmux else "rucan-e2e-ssh:local"
    with tempfile.TemporaryDirectory(prefix="rucan-ssh-") as temporary:
        container_id = output([
            "docker", "run", "--init", "--rm", "-d", "--network", "none", image,
        ])
        try:
            run(Path(temporary), container_id, Path("target/ssh-e2e/rucan-agent").resolve(), with_tmux)
        finally:
            subprocess.run(["docker", "stop", "-t", "2", container_id], check=False, stdout=subprocess.DEVNULL)
    print("Isolated SSH tmux ownership passed." if with_tmux else "Isolated SSH disconnect and reconnect passed.")
