import stringWidth from "string-width";
import type { Style, TerminalSnapshot } from "./snapshot.js";

const reset = "\x1b[0m";
const chrome = "\x1b[1;36m";
const brand = "\x1b[1;30;106m";
const activeTab = "\x1b[1;97;44m";
const connected = "\x1b[32m";
const attention = "\x1b[33m";
const divider = "\x1b[2m";
const hideCursor = "\x1b[?25l";
const move = (row: number, col: number): string => `\x1b[${row};${col}H`;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

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

function fit(text: string, width: number): string {
  const safe = text.replace(/[\p{Cc}\p{Bidi_Control}]/gu, "");
  if (stringWidth(safe) <= width) return safe;
  let result = "";
  let used = 0;
  for (const { segment } of segmenter.segment(safe)) {
    used += stringWidth(segment);
    if (used > width) break;
    result += segment;
  }
  return result;
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
  header:
    | string
    | {
        tab: string;
        status: string;
        healthy: boolean;
      };
  footer: string;
  sidebarLines: readonly string[];
  contentLines?: readonly string[];
  snapshot: TerminalSnapshot | undefined;
  showCursor: boolean;
}

function renderHeader(header: ScreenModel["header"], width: number): string {
  if (typeof header === "string") return chrome + fit(header, width) + reset;
  const logo = fit(" rucan ", width);
  const remaining = width - stringWidth(logo);
  if (remaining < 3) return brand + logo + reset;
  const tab = fit(
    ` ${header.tab} `,
    Math.min(remaining - 1, Math.max(12, Math.floor(width * 0.45))),
  );
  const status = fit(`  ● ${header.status}`, remaining - stringWidth(tab) - 1);
  return (
    brand +
    logo +
    reset +
    " " +
    activeTab +
    tab +
    reset +
    (header.healthy ? connected : attention) +
    status +
    reset
  );
}

/** Own every write to the outer terminal while the interactive UI is mounted. */
export class Screen {
  #output: NodeJS.WriteStream;
  #previous: string[] = [];
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
    } = model;
    const lines = [renderHeader(header, layout.cols)];
    for (let row = 0; row < layout.rows - 2; row++) {
      const sidebar = fit(
        sidebarLines[row] ?? "",
        Math.max(0, layout.sidebar - 1),
      );
      let line =
        layout.sidebar > 0
          ? (row === 0 || sidebar.startsWith("›")
              ? chrome + sidebar + reset
              : sidebar) +
            " ".repeat(Math.max(0, layout.sidebar - 1 - stringWidth(sidebar))) +
            divider +
            "│" +
            reset
          : "";
      let col = layout.sidebar;
      if (contentLines && layout.cols - col > 2) {
        const content = fit(contentLines[row] ?? "", layout.cols - col - 2);
        if (content)
          line += "  " + (row === 0 ? chrome : reset) + content + reset;
      }
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
    lines.push(chrome + fit(footer, layout.cols) + reset);

    let output = hideCursor;
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
