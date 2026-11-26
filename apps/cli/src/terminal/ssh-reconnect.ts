import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export function quoteSshScript(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export function reconnectingSsh(
  args: string[],
  target: string,
  directory: string | undefined,
): { command: string; args: string[] } {
  // A different workspace gets a different tmux session even on the same host.
  const id = `rucan-${randomUUID()}`;
  const changeDirectory = directory
    ? `cd ${quoteSshScript(directory)} || :; `
    : "";
  const script =
    'command -v tmux >/dev/null 2>&1 || { printf "%s\\n" "Resumable SSH requires tmux on the remote host." >&2; exit 127; }; ' +
    changeDirectory +
    `exec tmux new-session -A -s ${id}`;
  const remote = `sh -c ${quoteSshScript(script)}`;
  if (Buffer.byteLength(remote) > 4096)
    throw new Error("The SSH working directory is too long.");
  const development = import.meta.url.endsWith(".ts");
  const runner = fileURLToPath(
    new URL(
      `./ssh-reconnect-runner.${development ? "ts" : "js"}`,
      import.meta.url,
    ),
  );
  return {
    command: process.execPath,
    args: [
      ...(development ? ["--experimental-strip-types"] : []),
      runner,
      target,
      ...args,
      "-tt",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ServerAliveInterval=5",
      "-o",
      "ServerAliveCountMax=2",
      "--",
      target,
      remote,
    ],
  };
}
