import stringWidth from "string-width";
import { fit } from "./chrome.js";
import type { NativeWorkspace } from "./workspaces.js";

function withControl(label: string, width: number, control: string): string {
  const room = Math.max(0, width - 2 - stringWidth(control));
  const clipped = fit(label, room);
  return clipped + " ".repeat(room - stringWidth(clipped)) + " " + control;
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
      `BG${background}${workspaces.length === 0 ? " +" : "  "}`,
    ),
    ...lines
      .slice(1)
      .map((label, index) =>
        index < workspaces.length
          ? withControl(
              label,
              width,
              workspaces[index]?.ownership === "managed" ? "+ ×" : "+  ",
            )
          : label,
      ),
  ];
}

export function sidebarActionAt(
  row: number,
  col: number,
  width: number,
  workspaces: readonly NativeWorkspace[],
):
  | { type: "new"; workspaceIndex?: number }
  | { type: "background" }
  | { type: "close"; workspace: NativeWorkspace }
  | undefined {
  if (width < 7) return undefined;
  if (row === 2) {
    if (workspaces.length === 0 && col === width - 1) return { type: "new" };
    if (col >= width - 5 && col <= width - 3) return { type: "background" };
  }
  const workspaceIndex = row - 3;
  const workspace = workspaces[workspaceIndex];
  if (workspace && col === width - 3) return { type: "new", workspaceIndex };
  if (workspace?.ownership === "managed" && col === width - 1)
    return { type: "close", workspace };
  return undefined;
}
