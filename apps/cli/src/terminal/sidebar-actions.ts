import { fit } from "./chrome.js";
import type { NativeWorkspace } from "./workspaces.js";

export function workspaceSidebar(
  lines: readonly string[],
  width: number,
  selected?: NativeWorkspace,
): string[] {
  const background =
    selected?.ownership === "managed" ? (selected.persistent ? "●" : "○") : "–";
  const title = fit(lines[0] ?? "", Math.max(0, width - 7));
  return [
    title.padEnd(Math.max(0, width - 7)) + ` BG${background} +`,
    ...lines.slice(1),
  ];
}

export function sidebarActionAt(
  row: number,
  col: number,
  width: number,
): "new" | "background" | undefined {
  if (row !== 2 || width < 7) return undefined;
  if (col === width - 1) return "new";
  if (col >= width - 5 && col <= width - 3) return "background";
  return undefined;
}
