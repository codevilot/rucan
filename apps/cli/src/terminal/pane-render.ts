import stringWidth from "string-width";
import { fit, reset } from "./chrome.js";
import type { Divider, Pane, Rect } from "./panes.js";
import type { Style, TerminalSnapshot } from "./snapshot.js";

export interface PaneFrame {
  pane: Pane;
  name: string;
  snapshot: TerminalSnapshot | undefined;
  focused: boolean;
}

export const move = (row: number, col: number): string => `\x1b[${row};${col}H`;
const selectedTitle = "\x1b[1;38;5;231;48;5;61m";
const inactiveTitle = "\x1b[38;5;250;48;5;236m";
const dividerStyle = "\x1b[38;5;67;48;5;234m";
const previewStyle = "\x1b[1;38;5;231;48;5;60m";
const readableBlue = 256 + 0x0078d4;

function sgr([flags, fg, bg]: Style): string {
  const attributes = [0];
  const styles = [1, 2, 3, 4, 7];
  for (const [bit, code] of styles.entries()) {
    if (flags & (1 << bit)) attributes.push(code);
  }
  for (const [color, code] of [
    [fg === 4 && bg === -1 && !(flags & 16) ? readableBlue : fg, 38],
    [bg, 48],
  ] as const) {
    if (color >= 256) {
      const rgb = color - 256;
      attributes.push(code, 2, rgb >> 16, (rgb >> 8) & 255, rgb & 255);
    } else if (color >= 0) attributes.push(code, 5, color);
  }
  return `\x1b[${attributes.join(";")}m`;
}

export function renderTerminalRow(
  row: number,
  start: number,
  cols: number,
  spans: TerminalSnapshot["grid"]["lines"][number] | undefined,
): string {
  let col = start;
  let line = "";
  const end = start + cols;
  for (const [width, text, style] of spans ?? []) {
    if (col >= end) break;
    line += move(row, col) + sgr(style) + fit(text, Math.min(width, end - col));
    col += width;
  }
  return line;
}

export function renderPaneRow(
  row: number,
  panes: readonly PaneFrame[],
  dividers: readonly Divider[],
): string {
  let line = "";
  for (const { pane, name, snapshot, focused } of panes) {
    if (row === pane.y) {
      const label = fit(` ${name}`, pane.width - 1);
      line +=
        move(row, pane.x) +
        (focused ? selectedTitle : inactiveTitle) +
        label +
        " ".repeat(pane.width - 1 - stringWidth(label)) +
        "×" +
        reset;
    } else if (row > pane.y && row < pane.y + pane.height) {
      line += renderTerminalRow(
        row,
        pane.x,
        pane.width,
        snapshot?.grid.lines[row - pane.y - 1],
      );
    }
  }
  for (const divider of dividers) {
    if (row >= divider.y && row < divider.y + divider.height) {
      const bar = divider.split.axis === "x" ? "│" : "─".repeat(divider.width);
      line += move(row, divider.x) + dividerStyle + bar + reset;
    }
  }
  return line;
}

export function renderDropPreview(row: number, preview: Rect): string {
  if (row < preview.y || row >= preview.y + preview.height) return "";
  const label =
    row === preview.y + Math.floor(preview.height / 2)
      ? fit("Drop here", preview.width)
      : "";
  const left = Math.floor((preview.width - stringWidth(label)) / 2);
  return (
    move(row, preview.x) +
    previewStyle +
    " ".repeat(left) +
    label +
    " ".repeat(preview.width - left - stringWidth(label)) +
    reset
  );
}
