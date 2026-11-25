import type { SessionClient } from "../protocol/client.js";
import type { Geometry } from "./screen.js";
import { decodeWorkspace, type NativeWorkspace } from "./workspaces.js";

export interface TmuxTarget {
  id: string;
  name: string;
  cwd: string;
}

function decodeTarget(value: unknown): TmuxTarget {
  if (typeof value !== "object" || value === null)
    throw new Error("Invalid tmux target");
  const target = { ...value };
  if (
    !("id" in target) ||
    typeof target.id !== "string" ||
    !/^\$\d{1,16}$/u.test(target.id) ||
    !("name" in target) ||
    typeof target.name !== "string" ||
    !("cwd" in target) ||
    typeof target.cwd !== "string"
  ) {
    throw new Error("Invalid tmux target");
  }
  return { id: target.id, name: target.name, cwd: target.cwd };
}

export async function listTmux(
  client: SessionClient,
): Promise<{ available: boolean; sessions: TmuxTarget[] }> {
  const raw = await client.request({ type: "tmux-list" });
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("available" in raw) ||
    typeof raw.available !== "boolean" ||
    !("sessions" in raw) ||
    !Array.isArray(raw.sessions)
  )
    throw new Error("Invalid tmux inventory");
  return { available: raw.available, sessions: raw.sessions.map(decodeTarget) };
}

export async function openTmux(
  client: SessionClient,
  layout: Geometry,
  cwd: string,
  target: string | null,
): Promise<NativeWorkspace> {
  const name = "tman-" + Date.now().toString(36);
  return decodeWorkspace(
    await client.request({
      type: "tmux-open",
      target,
      name,
      cwd,
      rows: layout.terminalRows,
      cols: layout.terminalCols,
    }),
  );
}
