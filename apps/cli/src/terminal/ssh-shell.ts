import { isIP } from "node:net";
import type { Config } from "../config/schema.js";
import type { SessionClient } from "../protocol/client.js";
import type { Geometry } from "./screen.js";
import { decodeWorkspace, type NativeWorkspace } from "./workspaces.js";

export function validSshDestination(target: string): boolean {
  if (target.length === 0 || target.length > 255) return false;
  const parts = target.split("@");
  if (parts.length > 2) return false;
  if (
    parts.length === 2 &&
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(parts[0] ?? "")
  )
    return false;
  const host = parts.at(-1) ?? "";
  return isIP(host) === 6 || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(host);
}

export async function openSshShell(
  client: SessionClient,
  config: Config,
  layout: Geometry,
  target: string,
): Promise<NativeWorkspace> {
  if (!validSshDestination(target))
    throw new Error("Enter an SSH host or user@host.");
  return decodeWorkspace(
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
}
