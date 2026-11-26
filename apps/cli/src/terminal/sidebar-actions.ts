import stringWidth from "string-width";
import { fit } from "./chrome.js";
import { workspaceLabel, type NativeWorkspace } from "./workspaces.js";

const newButton = "[+]";
const closeButton = "[×]";
const renameButton = "✎";
const renameWidth = stringWidth(renameButton);
const buttonGap = " ";
const buttonWidth = stringWidth(newButton);
const newWithCloseOffset = buttonWidth + buttonGap.length;

function hitsButton(col: number, right: number): boolean {
  return col > right - buttonWidth && col <= right;
}

function withControl(label: string, width: number, control: string): string {
  const room = Math.max(0, width - 2 - stringWidth(control));
  const clipped = fit(label, room);
  return clipped + " ".repeat(room - stringWidth(clipped)) + " " + control;
}

function renameLabel(label: string, width: number): string {
  const room = width - 1 - (2 * buttonWidth + buttonGap.length) - renameWidth;
  if (room <= 0) return "";
  const clipped = fit(label, room);
  const gap = stringWidth(clipped) < room ? buttonGap : "";
  return clipped + gap + renameButton;
}

export function workspaceSidebar(
  lines: readonly string[],
  width: number,
  workspaces: readonly NativeWorkspace[],
  selected?: NativeWorkspace,
): string[] {
  const background =
    selected?.ownership === "managed" ? (selected.persistent ? "●" : "○") : "–";
  return [
    withControl(
      lines[0] ?? "",
      width,
      `BG${background}${workspaces.length === 0 ? buttonGap + newButton : "  "}`,
    ),
    ...lines.slice(1).map((label, index) => {
      const workspace = workspaces[index];
      if (!workspace) return label;
      const controls =
        newButton +
        buttonGap +
        (workspace.ownership === "managed"
          ? closeButton
          : " ".repeat(buttonWidth));
      const editable = renameLabel(label, width);
      const padding = width - 1 - stringWidth(editable + controls);
      return editable + " ".repeat(Math.max(0, padding)) + controls;
    }),
  ];
}

export function sidebarActionAt(
  row: number,
  col: number,
  width: number,
  workspaces: readonly NativeWorkspace[],
  selectedId?: string,
):
  | { type: "new"; workspaceIndex?: number }
  | { type: "background" }
  | { type: "close"; workspace: NativeWorkspace }
  | { type: "rename"; workspace: NativeWorkspace }
  | undefined {
  if (width < 7) return undefined;
  const right = width - 1;
  if (row === 2) {
    if (workspaces.length === 0 && hitsButton(col, right))
      return { type: "new" };
    if (workspaces.length === 0) return undefined;
    if (col >= width - 5 && col <= width - 3) return { type: "background" };
  }
  const workspaceIndex = row - 3;
  const workspace = workspaces[workspaceIndex];
  if (workspace && hitsButton(col, right - newWithCloseOffset))
    return { type: "new", workspaceIndex };
  if (workspace?.ownership === "managed" && hitsButton(col, right))
    return { type: "close", workspace };
  if (workspace) {
    const end = stringWidth(
      renameLabel(workspaceLabel(workspace, workspaceIndex, selectedId), width),
    );
    if (end > 0 && col > end - renameWidth && col <= end)
      return { type: "rename", workspace };
  }
  return undefined;
}
