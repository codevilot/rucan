import type { Terminal } from "@xterm/headless";

export interface TerminalCell {
  text: string;
  width: number;
  foreground: { kind: "default" } | { kind: "indexed" | "rgb"; value: number };
}

export interface VisibleGrid {
  buffer: "normal" | "alternate";
  cursor: { x: number; y: number };
  rows: TerminalCell[][];
}

// The parser's cells are the only source of text. The caller owns all display escapes.
export function readVisibleGrid(terminal: Terminal): VisibleGrid {
  const buffer = terminal.buffer.active;
  const rows: TerminalCell[][] = [];
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row);
    const cells: TerminalCell[] = [];
    for (let column = 0; column < terminal.cols; column++) {
      const cell = line?.getCell(column);
      if (!cell) {
        cells.push({ text: "", width: 1, foreground: { kind: "default" } });
        continue;
      }
      cells.push({
        text: cell.getChars().replace(/\p{Cc}/gu, ""),
        width: cell.getWidth(),
        foreground: cell.isFgDefault()
          ? { kind: "default" }
          : {
              kind: cell.isFgRGB() ? "rgb" : "indexed",
              value: cell.getFgColor(),
            },
      });
    }
    rows.push(cells);
  }
  return {
    buffer: buffer.type,
    cursor: { x: buffer.cursorX, y: buffer.cursorY },
    rows,
  };
}
