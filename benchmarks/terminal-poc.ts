import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import xterm from "@xterm/headless";

const markers = {
  bash: "SSUI-BASH",
  zsh: "SSUI-ZSH",
  vim: "SSUI-VIM",
  rapid: "SSUI-LINE 09999",
};
type Probe = keyof typeof markers;
const probes: Record<Probe, readonly string[]> = {
  bash: ["bash", "--noprofile", "--norc", "-c", "printf 'SSUI-BASH\\n'"],
  zsh: ["zsh", "-f", "-c", "printf 'SSUI-ZSH\\n'"],
  vim: [
    "vim",
    "-Nu",
    "NONE",
    "-i",
    "NONE",
    "-n",
    "-c",
    "call setline(1, 'SSUI-VIM')",
    "-c",
    "redraw!",
    "-c",
    "sleep 100m",
    "-c",
    "qa!",
  ],
  rapid: [
    "sh",
    "-c",
    'i=0; while [ "$i" -lt 10000 ]; do printf \'SSUI-LINE %05d\\n\' "$i"; i=$((i+1)); done',
  ],
};

async function probe(name: Probe, command: readonly string[]): Promise<void> {
  const terminal = new xterm.Terminal({
    cols: 80,
    rows: 24,
    scrollback: 1000,
    allowProposedApi: true,
  });
  const start = performance.now();
  let bytes = 0;
  let sawMarker = false;
  let sawAlternate = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("target/debug/examples/pty_probe", command, {
        env: {
          ...process.env,
          TERM: "xterm-256color",
          LINES: "24",
          COLUMNS: "80",
        },
        stdio: ["pipe", "pipe", "inherit"],
        timeout: 10_000,
      });
      child.stdin.end();
      child.once("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        child.stdout.pause();
        bytes += chunk.length;
        terminal.write(chunk, () => {
          const buffer = terminal.buffer.active;
          sawAlternate ||= buffer.type === "alternate";
          for (let row = 0; row < terminal.rows; row++) {
            sawMarker ||= (
              buffer.getLine(buffer.viewportY + row)?.translateToString(true) ??
              ""
            ).includes(markers[name]);
          }
          child.stdout.resume();
        });
      });
      child.once("close", (code) => {
        terminal.write("", () => {
          if (code === 0) resolve();
          else
            reject(
              new Error(`${name}: PTY fixture exited with status ${code}`),
            );
        });
      });
    });
    assert.ok(sawMarker, `${name}: marker did not appear in the visible grid`);
    assert.ok(
      terminal.buffer.normal.length <= terminal.rows + 1000,
      "Scrollback exceeded its bound",
    );
    if (name === "vim") {
      assert.ok(sawAlternate, "Vim did not enter the alternate buffer");
      assert.equal(terminal.buffer.active.type, "normal");
    }
    console.log(
      `${name}: ${bytes} bytes, ${(performance.now() - start).toFixed(1)} ms (spawn through parse)`,
    );
  } finally {
    terminal.dispose();
  }
}

console.log(`${platform()} ${process.arch}, Node ${process.version}`);
await promisify(execFile)("cargo", [
  "build",
  "--locked",
  "-q",
  "--example",
  "pty_probe",
]);
const suite: readonly Probe[] = ["bash", "zsh", "vim", "rapid"];
for (const name of suite) {
  await probe(name, probes[name]);
}
