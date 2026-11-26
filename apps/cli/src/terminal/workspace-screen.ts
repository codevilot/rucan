import { closeDialogLines } from "./close-dialog.js";
import type { Config } from "../config/schema.js";
import type { Explorer } from "../explorer/explorer.js";
import { version } from "../release/version.js";
import type { Geometry, ScreenModel } from "./screen.js";
import { workspaceSidebar } from "./sidebar-actions.js";
import type { TerminalSnapshot } from "./snapshot.js";
import type { TmuxTarget } from "./tmux.js";
import { footerFor, selectionLines, type Mode } from "./view.js";
import { workspaceLabels, type NativeWorkspace } from "./workspaces.js";

interface WorkspaceScreenState {
  config: Config;
  mode: Mode;
  host: string | undefined;
  status: string;
  update: string | undefined;
  layout: Geometry;
  resizingSidebar: boolean;
  selected: NativeWorkspace | undefined;
  workspaces: readonly NativeWorkspace[];
  snapshot: TerminalSnapshot | undefined;
  history: TerminalSnapshot | undefined;
  controlsInput: boolean;
  explorer: ReturnType<Explorer["layout"]> | undefined;
  canOpenExplorerFile: boolean;
  hosts: readonly (string | undefined)[];
  hostIndex: number;
  tmux: readonly TmuxTarget[];
  tmuxIndex: number;
  renameName: string | undefined;
  offset: number;
  sshTarget: string;
  sshReconnect: boolean;
  closeTarget: NativeWorkspace | undefined;
  paletteLines: readonly string[] | undefined;
}

export function workspaceScreen(state: WorkspaceScreenState): ScreenModel {
  const selected = state.selected;
  const title = selected
    ? `${selected.name}${selected.persistent ? " ◆" : ""}`
    : "No session";
  const explorer = state.mode === "explorer" ? state.explorer : undefined;
  const footer = footerFor(
    state.mode,
    state.offset,
    explorer?.canEdit,
    state.canOpenExplorerFile,
  );
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
    footer: state.update ? `${footer} · Update v${state.update}` : footer,
    resizingSidebar: state.resizingSidebar,
    sidebarLines:
      selection ??
      explorer?.sidebar ??
      workspaceSidebar(
        workspaceLabels(state.config, state.workspaces, selected?.id),
        state.layout.sidebar,
        state.workspaces,
        selected,
      ),
    ...(selection && state.layout.sidebar === 0
      ? { contentLines: selection }
      : explorer
        ? {
            contentLines:
              state.layout.sidebar === 0
                ? [
                    ...explorer.sidebar.slice(
                      0,
                      Math.floor((state.layout.rows - 2) / 2),
                    ),
                    ...explorer.content,
                  ]
                : explorer.content,
          }
        : state.mode === "ssh"
          ? {
              contentLines: [
                state.sshReconnect ? "SSH connect and resume" : "SSH connect",
                `Host  ${state.sshTarget}▏`,
                "Enter an IP, SSH alias, or user@host.",
              ],
            }
          : state.mode === "close" && state.closeTarget
            ? { paletteLines: closeDialogLines(state.closeTarget.name) }
            : state.mode === "rename" && state.renameName !== undefined
              ? {
                  paletteLines: [
                    "Rename workspace",
                    `${state.renameName}▏`,
                    "  Cancel",
                    "  Save",
                  ],
                }
              : state.mode === "palette" && state.paletteLines
                ? { paletteLines: state.paletteLines }
                : {}),
    snapshot:
      (selection && state.layout.sidebar === 0) ||
      explorer ||
      state.mode === "palette" ||
      state.mode === "close" ||
      state.mode === "rename" ||
      state.mode === "ssh"
        ? undefined
        : state.mode === "history"
          ? state.history
          : state.snapshot,
    showCursor: state.mode === "terminal" && state.controlsInput,
  };
}
