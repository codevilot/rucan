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
  count: number,
  selected?: NativeWorkspace,
): string[] {
  const background =
    selected?.ownership === "managed" ? (selected.persistent ? "●" : "○") : "–";
  return [
    withControl(
      lines[0] ?? "",
      width,
      `BG${background}${count === 0 ? " +" : "  "}`,
    ),
    ...lines
      .slice(1)
      .map((label, index) =>
        index < count ? withControl(label, width, "+") : label,
      ),
  ];
}

export function sidebarActionAt(
  row: number,
  col: number,
  width: number,
  count: number,
):
  | { type: "new"; workspaceIndex?: number }
  | { type: "background" }
  | undefined {
  if (width < 7) return undefined;
  if (row === 2) {
    if (count === 0 && col === width - 1) return { type: "new" };
    if (col >= width - 5 && col <= width - 3) return { type: "background" };
  }
  const workspaceIndex = row - 3;
  if (col === width - 1 && workspaceIndex >= 0 && workspaceIndex < count)
    return { type: "new", workspaceIndex };
  return undefined;
}
