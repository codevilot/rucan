"""Verify startup update choices with a real PTY and a mocked npm registry."""
import fcntl
import json
import os
from pathlib import Path
import pty
import signal
import struct
import subprocess
import tempfile
import termios
import time

from local_tty import PALETTE_HINT, choose_action, read_until

NODE = ["node", str(Path("apps/cli/dist/main.js").resolve())]


def run():
    current = subprocess.check_output(NODE + ["--version"], text=True).split()[1]
    major, minor, patch = current.split(".")
    newer = f"{major}.{minor}.{int(patch) + 1}"
    with tempfile.TemporaryDirectory(prefix="rucan-upd-") as temp:
        root = Path(temp)
        config = root / "rucan"
        config.mkdir(mode=0o700)
        (config / "config.yaml").write_text(
            'version: 1\nworkspaces: [{name: local, cwd: "~", command: "/bin/sh"}]\n'
        )
        preload = root / "registry.mjs"
        preload.write_text(
            'globalThis.fetch = async (url) => {\n'
            '  if (String(url) !== "https://registry.npmjs.org/rucan/latest") throw Error("Unexpected URL");\n'
            '  await new Promise((resolve) => setTimeout(resolve, Number(process.env.TEST_UPDATE_DELAY)));\n'
            '  return Response.json({ version: process.env.TEST_UPDATE_VERSION });\n'
            '};\n'
        )
        env = dict(
            os.environ,
            TERM="xterm-256color",
            XDG_CONFIG_HOME=temp,
            RUCAN_AGENT_SOCKET=str(root / "agent.sock"),
            RUCAN_AGENT_BINARY=str(Path("target/debug/rucan-agent").resolve()),
            NODE_OPTIONS=f"--import={preload}",
            TEST_UPDATE_VERSION=newer,
        )
        env.pop("RUCAN_SESSION_ID", None)
        stale_cache = root / "late/rucan"
        stale_cache.mkdir(parents=True)
        (stale_cache / "updates.json").write_text(
            json.dumps({"checkedAt": int(time.time() * 1000), "latest": current})
        )
        try:
            exercise(dict(env, XDG_CACHE_HOME=str(root / "early"), TEST_UPDATE_DELAY="0"), newer)
            exercise(dict(env, XDG_CACHE_HOME=str(root / "late"), TEST_UPDATE_DELAY="1500"), newer, late=True)
        finally:
            if (root / "agent.sock").is_socket():
                subprocess.check_call(NODE + ["shutdown", "--force"], env=env)


def exercise(env, newer, late=False):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
    process = subprocess.Popen(NODE, stdin=slave, stdout=slave, stderr=slave, env=env)
    try:
        if late:
            read_until(master, PALETTE_HINT)
            os.write(master, b"printf 'LATE-%s\\n' working\r")
            frame = read_until(master, f"Update v{newer}".encode())
            assert b"LATE-working" in frame
            assert b"Update available:" not in frame
        else:
            frame = read_until(master, b"3  Skip this version")
            assert b"1  Update and reopen this workspace" in frame
            assert b"2  Continue with this version" in frame
            os.write(master, b"2")
            read_until(master, PALETTE_HINT)
            os.write(master, b"printf 'EARLY-%s\\n' continued\r")
            read_until(master, b"EARLY-continued")

        choose_action(master, "Review update")
        read_until(master, b"3  Skip this version")
        os.write(master, b"3")
        read_until(master, PALETTE_HINT)
        assert (Path(env["XDG_CACHE_HOME"]) / "rucan/skip-version").read_text().strip() == newer
        choose_action(master, "Close UI")
        read_until(master, b"\x1b[?1049l")
        assert process.wait(timeout=5) == 0
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            process.wait(timeout=5)
        os.close(master)
        os.close(slave)


if __name__ == "__main__":
    run()
    print("Startup update PTY smoke passed")
