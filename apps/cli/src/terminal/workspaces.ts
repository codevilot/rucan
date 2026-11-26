import type { Config, WorkspaceConfig } from "../config/schema.js";
import type { SessionClient } from "../protocol/client.js";
import type { Geometry } from "./screen.js";
import { validSshDestination } from "../agent/ssh-destination.js";

export interface NativeWorkspace {
  name: string;
  customName?: true;
  location?: { host: string; path?: string };
  id: string;
  cwd: string;
  backend: "native" | "tmux";
  ownership: "managed" | "external";
  persistent: boolean;
  running: boolean;
  sshTarget?: string;
  sshReconnect?: boolean;
  pid?: number;
}

export function decodeWorkspace(raw: unknown): NativeWorkspace {
  if (typeof raw !== "object" || raw === null)
    throw new Error("Invalid agent workspace");
  const workspace = { ...raw };
  if (
    !("name" in workspace) ||
    typeof workspace.name !== "string" ||
    !("backend" in workspace) ||
    (workspace.backend !== "native" && workspace.backend !== "tmux") ||
    !("ownership" in workspace) ||
    (workspace.ownership !== "managed" && workspace.ownership !== "external") ||
    !("cwd" in workspace) ||
    typeof workspace.cwd !== "string" ||
    !("id" in workspace) ||
    typeof workspace.id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(workspace.id) ||
    !("persistent" in workspace) ||
    typeof workspace.persistent !== "boolean" ||
    !("state" in workspace) ||
    typeof workspace.state !== "object" ||
    workspace.state === null ||
    !("type" in workspace.state) ||
    !(
      workspace.state.type === "running" ||
      workspace.state.type === "exited" ||
      workspace.state.type === "wait-failed"
    )
  )
    throw new Error("Invalid agent workspace");
  return {
    name: workspace.name,
    ...("customName" in workspace && workspace.customName === true
      ? { customName: true as const }
      : {}),
    backend: workspace.backend,
    ownership: workspace.ownership,
    id: workspace.id,
    cwd: workspace.cwd,
    persistent: workspace.persistent,
    running: workspace.state.type === "running",
    ...("sshReconnect" in workspace &&
    typeof workspace.sshReconnect === "boolean"
      ? { sshReconnect: workspace.sshReconnect }
      : {}),
    ...("pid" in workspace &&
    typeof workspace.pid === "number" &&
    Number.isSafeInteger(workspace.pid) &&
    workspace.pid > 0 &&
    workspace.pid <= 0x7fffffff
      ? { pid: workspace.pid }
      : {}),
    ...("sshTarget" in workspace &&
    typeof workspace.sshTarget === "string" &&
    validSshDestination(workspace.sshTarget)
      ? { sshTarget: workspace.sshTarget }
      : {}),
  };
}

export async function listWorkspaces(
  client: SessionClient,
): Promise<NativeWorkspace[]> {
  const raw = await client.request({ type: "list" });
  if (!Array.isArray(raw)) throw new Error("Invalid agent workspace list");
  return raw
    .map(decodeWorkspace)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function reconcileWorkspaces(
  previous: readonly NativeWorkspace[],
  running: readonly NativeWorkspace[],
  selectedId: string | undefined,
): { workspaces: NativeWorkspace[]; next: NativeWorkspace | undefined } {
  const current = new Map(
    running.map((workspace) => [workspace.id, workspace]),
  );
  const workspaces = previous.flatMap((workspace) => {
    const latest = current.get(workspace.id);
    if (!latest) return [];
    current.delete(workspace.id);
    return [
      workspace.name === latest.name &&
      workspace.customName === latest.customName &&
      workspace.persistent === latest.persistent
        ? workspace
        : { ...workspace, ...latest },
    ];
  });
  workspaces.push(...current.values());
  const index = previous.findIndex(({ id }) => id === selectedId);
  return {
    workspaces,
    next: workspaces[Math.min(Math.max(0, index), workspaces.length - 1)],
  };
}

function defaultWorkspace(
  config: Config,
  host: string | undefined,
): WorkspaceConfig {
  return (
    config.workspaces.find(
      ({ host: entry, backend }) => entry === host && backend === "native",
    ) ?? {
      name: host ?? "local-shell",
      cwd: "~",
      command: (host ? undefined : process.env.SHELL) ?? "/bin/sh",
      backend: "native",
      persistence: config.defaults.persistence,
    }
  );
}

export async function createWorkspace(
  client: SessionClient,
  config: Config,
  layout: Geometry,
  host?: string,
  current?: NativeWorkspace,
  directory?: string,
): Promise<NativeWorkspace> {
  const configured =
    current &&
    config.workspaces.find(
      ({ host: entry, backend, name }) =>
        entry === host && backend === "native" && name === current.name,
    );
  const workspace = configured || defaultWorkspace(config, host);
  return decodeWorkspace(
    await client.request({
      type: "create",
      name: workspace.name,
      cwd: directory ?? current?.cwd ?? workspace.cwd,
      command: workspace.command,
      args: [],
      rows: layout.terminalRows,
      cols: layout.terminalCols,
      persistent: workspace.persistence === "persistent",
      scrollback: config.terminal.scrollback_lines,
    }),
  );
}

export function workspaceLabels(
  config: Config,
  sessions: readonly NativeWorkspace[],
  activeId: string | undefined,
): string[] {
  const labels = [
    "WORKSPACES",
    ...sessions.map((workspace, index) =>
      workspaceLabel(workspace, index, activeId),
    ),
  ];
  for (const workspace of config.workspaces) {
    if (workspace.host) labels.push(`  ○ ${workspace.name} (SSH)`);
    else if (workspace.backend === "tmux")
      labels.push(`  ○ ${workspace.name} (tmux)`);
  }
  return labels;
}

export function workspaceLabel(
  workspace: NativeWorkspace,
  index: number,
  activeId?: string,
  displayName = workspace.name,
): string {
  const selected = workspace.id === activeId ? "›" : " ";
  const pin =
    workspace.backend === "tmux" ? "T" : workspace.persistent ? "◆" : "◇";
  const slot = index < 9 ? String(index + 1) : " ";
  return `${selected}${slot} ${pin} ${displayName}`;
}
