import type { Config } from "../config/schema.js";
import type { SessionClient } from "../protocol/client.js";
import type { Geometry } from "./screen.js";
import { validSshDestination } from "./ssh-destination.js";
import { decodeWorkspace, type NativeWorkspace } from "./workspaces.js";

export async function openSshShell(
  client: SessionClient,
  config: Config,
  layout: Geometry,
  target: string,
): Promise<NativeWorkspace> {
  if (!validSshDestination(target))
    throw new Error("Enter an SSH host or user@host.");
  const workspace = decodeWorkspace(
    await client.request({
      type: "create",
      name: target,
      cwd: "~",
      command: "ssh",
      args: ["-o", "StrictHostKeyChecking=ask", "--", target],
      rows: layout.terminalRows,
      cols: layout.terminalCols,
      persistent: config.defaults.persistence === "persistent",
      scrollback: config.terminal.scrollback_lines,
    }),
  );
  return { ...workspace, sshTarget: target };
}
