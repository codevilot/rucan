import type { Config } from "../config/schema.js";
import type { SessionClient } from "../protocol/client.js";
import type { Geometry } from "./screen.js";
import { validSshDestination } from "../agent/ssh-destination.js";
import { decodeWorkspace, type NativeWorkspace } from "./workspaces.js";

function quote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

export async function openSshShell(
  client: SessionClient,
  config: Config,
  layout: Geometry,
  target: string,
  directory?: string,
): Promise<NativeWorkspace> {
  if (!validSshDestination(target))
    throw new Error("Enter an SSH host or user@host.");
  const args = ["-o", "StrictHostKeyChecking=ask"];
  if (directory) {
    const reported = directory.split("/").map(encodeURIComponent).join("/");
    const script =
      `cd ${quote(directory)} && printf '\\033]7;file://%s\\007' ${quote(reported)} && ` +
      'exec "${SHELL:-/bin/sh}" -i';
    const command = `sh -c ${quote(script)}`;
    if (Buffer.byteLength(command) > 4096)
      throw new Error("The SSH working directory is too long.");
    args.push("-t", "--", target, command);
  } else {
    args.push("--", target);
  }
  const workspace = decodeWorkspace(
    await client.request({
      type: "create",
      name: target,
      cwd: "~",
      command: "ssh",
      args,
      rows: layout.terminalRows,
      cols: layout.terminalCols,
      persistent: config.defaults.persistence === "persistent",
      scrollback: config.terminal.scrollback_lines,
    }),
  );
  return { ...workspace, sshTarget: target };
}
