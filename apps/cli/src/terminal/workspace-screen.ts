import type { Config, WorkspaceConfig } from "../config/schema.js";
import type { Explorer } from "../explorer/explorer.js";
import { version } from "../release/version.js";
import type { Geometry, ScreenModel } from "./screen.js";
import { workspaceSidebar } from "./sidebar-actions.js";
import type { TerminalSnapshot } from "./snapshot.js";
import type { TmuxTarget } from "./tmux.js";
import {
  exitLines,
  footerFor,
  menuFor,
  selectionLines,
  type Mode,
} from "./view.js";
import { workspaceLabels, type NativeWorkspace } from "./workspaces.js";

interface WorkspaceScreenState {
  config: Config;
  mode: Mode;
  host: string | undefined;
  status: string;
  update: string | undefined;
  layout: Geometry;
  selected: NativeWorkspace | undefined;
  workspaces: readonly NativeWorkspace[];
  snapshot: TerminalSnapshot | undefined;
  history: TerminalSnapshot | undefined;
  controlsInput: boolean;
  explorer: ReturnType<Explorer["layout"]> | undefined;
  newEntries: readonly WorkspaceConfig[];
  newIndex: number;
  hosts: readonly (string | undefined)[];
  hostIndex: number;
  tmux: readonly TmuxTarget[];
  tmuxIndex: number;
  name: string;
  offset: number;
  command: string;
  commandError: boolean;
  sshTarget: string;
  paletteLines: readonly string[] | undefined;
}

export function workspaceScreen(state: WorkspaceScreenState): ScreenModel {
  const selected = state.selected;
  const title = selected
    ? `${selected.name}${selected.persistent ? " ◆" : ""}`
    : "No session";
  const footer = footerFor(
    state.mode,
    state.config.terminal.prefix_key,
    state.name,
    state.offset,
  );
  const explorer = state.mode === "explorer" ? state.explorer : undefined;
  if (state.mode === "update" && state.update) {
    return {
      layout: state.layout,
      header: `Update available: v${version} → v${state.update}`,
      footer,
      sidebarLines: [],
      paletteLines: [
        "◆  Rucan update",
        `v${version} → v${state.update}`,
        "   1  Update and reopen this workspace",
        "   2  Continue with this version",
        "   3  Skip this version",
      ],
      snapshot: undefined,
      showCursor: false,
    };
  }
  const selection =
    (state.mode === "create"
      ? selectionLines(
          "OPEN WORKSPACE",
          ["Default shell", ...state.newEntries.map(({ name }) => name)],
          state.newIndex,
          state.layout.rows - 2,
        )
      : undefined) ??
    (state.mode === "hosts"
      ? selectionLines(
          "HOSTS",
          state.hosts.map((host) => host ?? "Local"),
          state.hostIndex,
          state.layout.rows - 2,
        )
      : undefined) ??
    (state.mode === "tmux"
      ? selectionLines(
          "TMUX SESSIONS",
          state.tmux.map((entry) => entry.name),
          state.tmuxIndex,
          state.layout.rows - 2,
        )
      : undefined);
  const running = state.snapshot?.state === "running";
  return {
    layout: state.layout,
    header: {
      tab: title,
      status:
        state.status ||
        (running
          ? state.host
            ? `${state.host} connected`
            : "Local agent connected"
          : "No active workspace"),
      healthy: running && !state.status,
    },
    footer:
      state.update && state.mode !== "exit"
        ? `${footer} · U Review v${state.update}`
        : footer,
    sidebarLines:
      selection ??
      explorer?.sidebar ??
      workspaceSidebar(
        workspaceLabels(state.config, state.workspaces, selected?.id),
        state.layout.rows - 2,
      ),
    ...(selection && state.layout.sidebar === 0
      ? { contentLines: selection }
      : explorer
        ? { contentLines: explorer.content }
        : state.mode === "menu"
          ? { contentLines: menuFor(state.update) }
          : state.mode === "exit"
            ? { contentLines: exitLines(state.host) }
            : state.mode === "command"
              ? {
                  contentLines: [
                    `Command  /${state.command}▏`,
                    "",
                    state.commandError
                      ? "Unknown command. Try /exit."
                      : "/exit  Quit Rucan",
                  ],
                }
              : state.mode === "ssh"
                ? {
                    contentLines: [
                      "SSH connect",
                      `Host  ${state.sshTarget}▏`,
                      "Enter an IP, SSH alias, or user@host.",
                    ],
                  }
                : state.mode === "palette" && state.paletteLines
                  ? { paletteLines: state.paletteLines }
                  : {}),
    snapshot:
      (selection && state.layout.sidebar === 0) ||
      explorer ||
      state.mode === "menu" ||
      state.mode === "palette" ||
      state.mode === "ssh" ||
      state.mode === "exit" ||
      state.mode === "command"
        ? undefined
        : state.mode === "history"
          ? state.history
          : state.snapshot,
    showCursor: state.mode === "terminal" && state.controlsInput,
  };
}
