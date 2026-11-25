import {
  fit,
  renderFooter,
  renderHeader,
  renderPaletteLine,
  renderPanelLine,
  renderSidebar,
  reset,
  type Header,
} from "./chrome.js";
import type { Style, TerminalSnapshot } from "./snapshot.js";

const hideCursor = "\x1b[?25l";
const move = (row: number, col: number): string => `\x1b[${row};${col}H`;

export interface Geometry {
  rows: number;
  cols: number;
  sidebar: number;
  terminalRows: number;
  terminalCols: number;
}

export function geometry(rows: number, cols: number): Geometry {
  const sidebar = cols >= 48 ? Math.max(16, Math.floor(cols * 0.25)) : 0;
  const terminalCols = Math.max(1, Math.min(500, cols - sidebar));
  const terminalRows = Math.max(
    1,
    Math.min(200, rows - 2, Math.floor(12000 / terminalCols)),
  );
  return { rows, cols, sidebar, terminalRows, terminalCols };
}

function sgr([flags, fg, bg]: Style): string {
  const attributes = [0];
  const styles = [1, 2, 3, 4, 7];
  for (const [bit, code] of styles.entries()) {
    if (flags & (1 << bit)) attributes.push(code);
  }
  for (const [color, code] of [
    [fg, 38],
    [bg, 48],
  ] as const) {
    if (color >= 256) {
      const rgb = color - 256;
      attributes.push(code, 2, rgb >> 16, (rgb >> 8) & 255, rgb & 255);
    } else if (color >= 0) attributes.push(code, 5, color);
  }
  return `\x1b[${attributes.join(";")}m`;
}

export interface ScreenModel {
  layout: Geometry;
  header: Header;
  footer: string;
  sidebarLines: readonly string[];
  contentLines?: readonly string[];
  paletteLines?: readonly string[];
  snapshot: TerminalSnapshot | undefined;
  showCursor: boolean;
}

/** Own every write to the outer terminal while the interactive UI is mounted. */
export class Screen {
  #output: NodeJS.WriteStream;
  #previous: string[] = [];
  #paintedLayout: Geometry | undefined;
  #latest: ScreenModel | undefined;
  #blocked = false;
  #keyModes = "";
  #mouseMode = "";

  constructor(output: NodeJS.WriteStream) {
    this.#output = output;
  }

  enter(): void {
    this.#output.write("\x1b[?1049h\x1b[2J\x1b[?2004h" + hideCursor);
  }

  draw(model: ScreenModel): void {
    this.#latest = model;
    if (!this.#blocked) this.#flush();
  }

  #onDrain = (): void => {
    this.#blocked = false;
    this.#flush();
  };

  #flush(): void {
    const model = this.#latest;
    if (!model) return;
    const {
      layout,
      header,
      footer,
      sidebarLines,
      snapshot,
      showCursor,
      contentLines,
      paletteLines,
    } = model;
    const lines = [renderHeader(header, layout.cols)];
    const paletteTop = Math.max(
      0,
      Math.floor((layout.rows - 2 - (paletteLines?.length ?? 0)) / 3),
    );
    for (let row = 0; row < layout.rows - 2; row++) {
      let line = renderSidebar(
        sidebarLines[row] ?? "",
        layout.sidebar,
        row === 0,
      );
      let col = layout.sidebar;
      const paletteLine = paletteLines?.[row - paletteTop];
      if (paletteLine)
        line += renderPaletteLine(
          paletteLine,
          layout.cols - col,
          row - paletteTop,
        );
      else if (contentLines)
        line += renderPanelLine(
          contentLines[row] ?? "",
          layout.cols - col,
          row,
        );
      for (const [width, text, style] of snapshot?.grid.lines[row] ?? []) {
        if (col >= layout.cols) break;
        line +=
          move(row + 2, col + 1) +
          sgr(style) +
          fit(text, Math.min(width, layout.cols - col));
        col += width;
      }
      lines.push(line + reset);
    }
    lines.push(renderFooter(footer, layout.cols));

    let output = hideCursor;
    if (
      this.#paintedLayout &&
      (this.#paintedLayout.rows !== layout.rows ||
        this.#paintedLayout.cols !== layout.cols)
    ) {
      // The outer terminal may have reflowed rows since the last frame.
      output += reset + "\x1b[2J";
      this.#previous = [];
    }
    this.#paintedLayout = layout;
    const last = Math.max(lines.length, this.#previous.length);
    for (let index = 0; index < last; index++) {
      const line = lines[index] ?? "";
      if (line !== this.#previous[index])
        output += move(index + 1, 1) + reset + "\x1b[2K" + line;
    }
    const grid = showCursor ? snapshot?.grid : undefined;
    const modes =
      (grid?.applicationCursor ? "\x1b[?1h" : "\x1b[?1l") +
      (grid?.applicationKeypad ? "\x1b=" : "\x1b>");
    if (modes !== this.#keyModes) {
      output += modes;
      this.#keyModes = modes;
    }
    const mouse =
      grid?.mouse === "any-motion"
        ? "1003"
        : grid?.mouse === "button-motion"
          ? "1002"
          : "1000";
    if (mouse !== this.#mouseMode) {
      output +=
        "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006h" + `\x1b[?${mouse}h`;
      this.#mouseMode = mouse;
    }
    this.#previous = lines;
    if (
      snapshot &&
      showCursor &&
      !snapshot.grid.cursorHidden &&
      snapshot.cursor.row < layout.terminalRows
    ) {
      output +=
        move(
          snapshot.cursor.row + 2,
          Math.min(layout.cols, layout.sidebar + snapshot.cursor.column + 1),
        ) + "\x1b[?25h";
    }
    this.#blocked = !this.#output.write(output);
    if (this.#blocked) this.#output.once("drain", this.#onDrain);
  }

  leave(): void {
    this.#latest = undefined;
    this.#output.off("drain", this.#onDrain);
    this.#output.write(
      reset +
        "\x1b[?1l\x1b>\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1049l\x1b[?25h",
    );
  }
}
