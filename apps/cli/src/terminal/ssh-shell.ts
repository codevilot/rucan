import type { Config } from "../config/schema.js";
import type { SessionClient } from "../protocol/client.js";
import { reconnectingSsh } from "./ssh-reconnect.js";
import { sshShellCommand } from "./ssh-directory-report.js";
import { sshSharingArgs } from "./ssh-sharing.js";
import type { Geometry } from "./screen.js";
import { validSshDestination } from "../agent/ssh-destination.js";
import { decodeWorkspace, type NativeWorkspace } from "./workspaces.js";

export async function openSshShell(
  client: SessionClient,
  config: Config,
  layout: Geometry,
  target: string,
  directory: string | undefined,
  local: boolean,
  reconnect = false,
): Promise<NativeWorkspace> {
  if (!validSshDestination(target))
    throw new Error("Enter an SSH host or user@host.");
  const args = local ? await sshSharingArgs(target, reconnect) : [];
  args.push("-o", "StrictHostKeyChecking=ask");
  if (reconnect && !local)
    throw new Error("Open resumable SSH from the local workspace.");
  const program = reconnect
    ? reconnectingSsh(args, target, directory)
    : { command: "ssh", args };
  if (!reconnect) {
    const command = sshShellCommand(directory);
    if (Buffer.byteLength(command) > 4096)
      throw new Error("The SSH working directory is too long.");
    args.push("-t", "--", target, command);
  }
  const workspace = decodeWorkspace(
    await client.request({
      type: "create",
      name: target,
      cwd: "~",
      ...program,
      rows: layout.terminalRows,
      cols: layout.terminalCols,
      persistent: config.defaults.persistence === "persistent",
      scrollback: config.terminal.scrollback_lines,
    }),
  );
  return {
    ...workspace,
    sshTarget: target,
    ...(reconnect ? { sshReconnect: true } : {}),
  };
}
