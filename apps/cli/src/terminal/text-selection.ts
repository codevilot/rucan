import { execFile } from "node:child_process";
import stringWidth from "string-width";
import type { Rect } from "./panes.js";
import type { TerminalSnapshot } from "./snapshot.js";

type Point = { row: number; col: number };
type SelectionArea = Rect & { grid: TerminalSnapshot["grid"] };
export interface SelectedRow {
  row: number;
  col: number;
  text: string;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class TextSelection {
  constructor(
    private readonly area: SelectionArea,
    readonly start: Point,
    public end = start,
  ) {}

  get moved(): boolean {
    return this.start.row !== this.end.row || this.start.col !== this.end.col;
  }

  rows(): SelectedRow[] {
    const { area, start, end } = this;
    const clamp = (point: Point): Point => ({
      row: Math.max(area.y, Math.min(area.y + area.height - 1, point.row)),
      col: Math.max(area.x, Math.min(area.x + area.width - 1, point.col)),
    });
    const first = clamp(start);
    const last = clamp(end);
    const [from, to] =
      first.row < last.row || (first.row === last.row && first.col <= last.col)
        ? [first, last]
        : [last, first];
    const rows: SelectedRow[] = [];
    for (let row = from.row; row <= to.row; row++) {
      const left = row === from.row ? from.col : area.x;
      const right = row === to.row ? to.col : area.x + area.width - 1;
      let col = area.x;
      let text = "";
      let firstCol = left;
      for (const [width, span] of area.grid.lines[row - area.y] ?? []) {
        let cell = col;
        for (const { segment } of graphemes.segment(span)) {
          const length = stringWidth(segment);
          if (cell <= right && cell + length > left) {
            if (!text) firstCol = cell;
            text += segment;
          }
          cell += length;
        }
        col += width;
        if (col > right) break;
      }
      rows.push({ row, col: firstCol, text });
    }
    return rows;
  }
}

export function copyMacText(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("pbcopy", { timeout: 3000 }, (error) => {
      if (error) reject(new Error("Could not copy terminal text"));
      else resolve();
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);
  });
}
