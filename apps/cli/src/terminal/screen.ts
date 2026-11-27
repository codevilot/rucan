import type { SelectedRow } from "./text-selection.js";
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
import type { TerminalSnapshot } from "./snapshot.js";
import type { Divider, Rect } from "./panes.js";
import {
  move,
  renderDropPreview,
  renderPaneRow,
  renderTerminalRow,
  type PaneFrame,
} from "./pane-render.js";
export type { PaneFrame } from "./pane-render.js";
import { sidebarWidth } from "./sidebar-layout.js";
import { paletteBounds } from "./palette-layout.js";
import type { Writable } from "node:stream";

const resizePointer = "\x1b]22;ew-resize\x1b\\";
const resetPointer = "\x1b]22;\x1b\\";
const hideCursor = "\x1b[?25l";

export interface Geometry {
  rows: number;
  cols: number;
  sidebar: number;
  sidebarSide: "left" | "right";
  contentStart: number;
  terminalRows: number;
  terminalCols: number;
}

export function geometry(
  rows: number,
  cols: number,
  preferredSidebar?: number,
  sidebarSide: Geometry["sidebarSide"] = "left",
): Geometry {
  const sidebar = sidebarWidth(cols, preferredSidebar);
  const terminalCols = Math.max(1, Math.min(500, cols - sidebar));
  const terminalRows = Math.max(
    1,
    Math.min(200, rows - 2, Math.floor(12000 / terminalCols)),
  );
  const contentStart = sidebarSide === "left" ? sidebar : 0;
  return {
    rows,
    cols,
    sidebar,
    sidebarSide,
    contentStart,
    terminalRows,
    terminalCols,
  };
}

export interface ScreenModel {
  layout: Geometry;
  header: Header;
  footer: string;
  sidebarLines: readonly string[];
  resizingSidebar?: boolean;
  textSelection?: boolean;
  selectedRows?: readonly SelectedRow[];
  contentLines?: readonly string[];
  paletteLines?: readonly string[];
  snapshot: TerminalSnapshot | undefined;
  showCursor: boolean;
  panes?: readonly PaneFrame[];
  dividers?: readonly Divider[];
  dropPreview?: Rect;
}

/** Own every write to the outer terminal while the interactive UI is mounted. */
export class Screen {
  #output: Writable;
  #previous: string[] = [];
  #paintedLayout: Geometry | undefined;
  #latest: ScreenModel | undefined;
  #painted: ScreenModel | undefined;
  #blocked = false;
  #keyModes = "";
  #mouseMode = "";
  #resizingSidebar = false;

  constructor(output: Writable) {
    this.#output = output;
  }

  enter(): void {
    this.#output.write("\x1b[?1049h\x1b[?7l\x1b[2J\x1b[?2004h" + hideCursor);
  }

  draw(model: ScreenModel): void {
    this.#latest = model;
    if (!this.#blocked) this.#flush();
  }

  paletteLineAt(row: number, col: number): number | undefined {
    const painted = this.#painted;
    if (this.#blocked || painted !== this.#latest || !painted?.paletteLines)
      return undefined;
    const { top, left, width } = paletteBounds(painted.layout);
    const line = row - top;
    return width >= 4 &&
      col >= left &&
      col < left + width &&
      row < painted.layout.rows &&
      line >= 0 &&
      line < painted.paletteLines.length
      ? line
      : undefined;
  }

  #onDrain = (): void => {
    this.#blocked = false;
    if (this.#latest !== this.#painted) this.#flush();
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
      panes,
      dividers = [],
      dropPreview,
    } = model;
    const lines = [renderHeader(header, layout.cols)];
    const paletteTop = paletteBounds(layout).top - 2;
    const contentWidth = layout.cols - layout.sidebar;
    const contentEnd = layout.contentStart + contentWidth;
    const rightSidebar = layout.sidebarSide === "right";
    const resizingSidebar =
      model.resizingSidebar === true && layout.sidebar > 0;
    for (let row = 0; row < layout.rows - 2; row++) {
      const sidebar = renderSidebar(
        sidebarLines[row] ?? "",
        layout.sidebar,
        row === 0,
        rightSidebar,
        resizingSidebar,
      );
      let line = rightSidebar ? "" : sidebar;
      const terminalRow = row + 2;
      const paletteLine = paletteLines?.[row - paletteTop];
      if (paletteLine)
        line += renderPaletteLine(paletteLine, contentWidth, row - paletteTop);
      else if (contentLines)
        line += renderPanelLine(contentLines[row] ?? "", contentWidth, row);
      line += panes?.length
        ? renderPaneRow(terminalRow, panes, dividers)
        : renderTerminalRow(
            terminalRow,
            layout.contentStart + 1,
            contentWidth,
            snapshot?.grid.lines[row],
          );
      const selection = model.selectedRows?.find(
        ({ row }) => row === terminalRow,
      );
      if (selection?.text)
        line +=
          move(terminalRow, selection.col) +
          reset +
          "\x1b[7m" +
          fit(selection.text, layout.cols - selection.col + 1) +
          reset;
      if (dropPreview) line += renderDropPreview(terminalRow, dropPreview);
      if (rightSidebar && layout.sidebar > 0)
        line += move(row + 2, contentEnd + 1) + sidebar;
      lines.push(line + reset);
    }
    lines.push(renderFooter(footer, layout.cols));

    let output = hideCursor;
    if (resizingSidebar !== this.#resizingSidebar) {
      output += resizingSidebar ? resizePointer : resetPointer;
      this.#resizingSidebar = resizingSidebar;
    }
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
    const focused = panes?.find(({ focused }) => focused);
    const terminal = focused?.snapshot ?? snapshot;
    const grid = showCursor ? terminal?.grid : undefined;
    const modes =
      (grid?.applicationCursor ? "\x1b[?1h" : "\x1b[?1l") +
      (grid?.applicationKeypad ? "\x1b=" : "\x1b>");
    if (modes !== this.#keyModes) {
      output += modes;
      this.#keyModes = modes;
    }
    const mouse = model.textSelection
      ? "off"
      : grid?.mouse === "any-motion"
        ? "1003"
        : "1002";
    if (mouse !== this.#mouseMode) {
      output += "\x1b[?1000l\x1b[?1002l\x1b[?1003l";
      output += mouse === "off" ? "\x1b[?1006l" : `\x1b[?1006h\x1b[?${mouse}h`;
      this.#mouseMode = mouse;
    }
    this.#previous = lines;
    this.#painted = model;
    if (
      terminal &&
      grid &&
      !dropPreview &&
      !grid.cursorHidden &&
      terminal.cursor.row <
        (focused ? focused.pane.height - 1 : layout.terminalRows)
    ) {
      const contentX = focused?.pane.x ?? layout.contentStart + 1;
      const contentY = focused ? focused.pane.y + 1 : 2;
      const contentCols = focused?.pane.width ?? contentWidth;
      output +=
        move(
          contentY + terminal.cursor.row,
          Math.min(
            contentX + contentCols - 1,
            contentX + terminal.cursor.column,
          ),
        ) + "\x1b[?25h";
    }
    this.#blocked = !this.#output.write(output);
    if (this.#blocked) this.#output.once("drain", this.#onDrain);
  }

  copyText(text: string): void {
    this.#output.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  }

  leave(): void {
    this.#latest = undefined;
    this.#output.off("drain", this.#onDrain);
    const pointer = this.#resizingSidebar ? resetPointer : "";
    this.#resizingSidebar = false;
    this.#output.write(
      pointer +
        reset +
        "\x1b[?1l\x1b>\x1b[?2004l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?7h\x1b[?1049l\x1b[?25h",
    );
  }
}
