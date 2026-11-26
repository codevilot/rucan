import { Writable } from "node:stream";
import { once } from "node:events";
import xterm from "@xterm/headless";
import { expect, it } from "vitest";
import { CommandPalette } from "../apps/cli/src/terminal/palette.js";
import { paletteBounds } from "../apps/cli/src/terminal/palette-layout.js";
import { renderTerminalRow } from "../apps/cli/src/terminal/pane-render.js";
import { geometry, Screen } from "../apps/cli/src/terminal/screen.js";

it("brightens the default-background ANSI blue used by shell prompts", () => {
  expect(renderTerminalRow(2, 1, 20, [[4, "docs", [0, 4, -1]]])).toContain(
    "\x1b[0;38;2;0;120;212mdocs",
  );
  expect(renderTerminalRow(2, 1, 20, [[4, "docs", [0, 4, 15]]])).toContain(
    "\x1b[0;38;5;4;48;5;15mdocs",
  );
});

it("keeps one clickable command card across filtering, reopening, and resizing", async () => {
  const terminal = new xterm.Terminal({
    cols: 100,
    rows: 24,
    allowProposedApi: true,
  });
  const chunks: string[] = [];
  const screen = new Screen(
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk.toString("utf8"));
        callback();
      },
    }),
  );
  const palette = new CommandPalette([], undefined, undefined, true);
  let layout = geometry(24, 100);

  async function render(open: boolean): Promise<string[]> {
    screen.draw({
      layout,
      header: "Rucan",
      footer: "Option+Space Palette",
      sidebarLines: ["WORKSPACES", "local-shell"],
      snapshot: undefined,
      showCursor: false,
      ...(open ? { paletteLines: palette.lines(layout.rows - 2) } : {}),
    });
    await new Promise<void>((resolve) =>
      terminal.write(chunks.splice(0).join(""), resolve),
    );
    const buffer = terminal.buffer.active;
    return Array.from(
      { length: layout.rows },
      (_, row) =>
        buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
    );
  }

  screen.enter();
  try {
    for (const [rows, cols, side] of [
      [24, 100, "left"],
      [15, 42, "left"],
      [30, 118, "right"],
    ] as const) {
      terminal.resize(cols, rows);
      layout = geometry(rows, cols, undefined, side);
      const open = await render(true);
      const { top, left } = paletteBounds(layout);
      expect(
        open.filter((line) => line.includes("Rucan commands")),
      ).toHaveLength(1);
      expect(open[top - 1]).toContain("Rucan commands");
      expect(open.some((line) => line.includes("New workspace"))).toBe(true);

      palette.input("browse");
      const filtered = await render(true);
      expect(
        filtered.filter((line) => line.includes("Rucan commands")),
      ).toHaveLength(1);
      expect(filtered.some((line) => line.includes("New workspace"))).toBe(
        false,
      );
      expect(filtered[top + 1]).toContain("Browse files");
      const hit = screen.paletteLineAt(top + 2, left);
      expect(hit).toBe(2);
      expect(palette.actionAt(hit ?? -1, rows - 2)).toEqual({
        kind: "command",
        key: "e",
      });
      expect(screen.paletteLineAt(top + 2, left - 1)).toBeUndefined();
      expect(screen.paletteLineAt(top + 3, left)).toBeUndefined();

      palette.input("無");
      const empty = await render(true);
      expect(
        empty.filter((line) => line.includes("Rucan commands")),
      ).toHaveLength(1);
      expect(empty.some((line) => line.includes("No matching actions"))).toBe(
        true,
      );
      expect(palette.actionAt(2, rows - 2)).toBeUndefined();
      const closed = await render(false);
      expect(closed.some((line) => line.includes("Rucan commands"))).toBe(
        false,
      );
      expect(screen.paletteLineAt(top + 2, left)).toBeUndefined();
      for (let i = 0; i < 7; i++) palette.input("\x7f");
      await render(true);
    }
  } finally {
    screen.leave();
    terminal.dispose();
  }
});

it("ignores clicks until the current palette frame drains", async () => {
  const pending: (() => void)[] = [];
  const output = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      pending.push(() => callback());
    },
  });
  const layout = geometry(24, 100);
  const screen = new Screen(output);
  const model = {
    layout,
    header: "Rucan",
    footer: "Option+Space Palette",
    sidebarLines: [],
    snapshot: undefined,
    showCursor: false,
  };
  screen.draw({ ...model, paletteLines: ["Title", "Search", "First", "Old"] });
  screen.draw({ ...model, paletteLines: ["Title", "Search", "Current"] });
  const { top, left } = paletteBounds(layout);
  expect(screen.paletteLineAt(top + 2, left)).toBeUndefined();

  for (let frame = 0; frame < 2; frame++) {
    const drained = once(output, "drain");
    const finish = pending.shift();
    expect(finish).toBeDefined();
    finish?.();
    await drained;
  }
  expect(pending).toHaveLength(0);
  expect(screen.paletteLineAt(top + 2, left)).toBe(2);
  expect(screen.paletteLineAt(top + 3, left)).toBeUndefined();
  output.destroy();
});

it("opens SSH connect from the command palette", () => {
  const palette = new CommandPalette([], "selected", undefined, true);
  palette.input("SSH connect");
  expect(palette.input("\r")).toEqual({ kind: "command", key: "c" });
});

it("opens the resumable SSH action from the command palette", () => {
  const palette = new CommandPalette([], "selected", undefined, true);
  palette.input("SSH connect and resume");
  expect(palette.input("\r")).toEqual({ kind: "command", key: "C" });
});

it.each(["Switch host", "Manage tmux sessions", "View terminal history"])(
  "omits %s from palette search",
  (query) => {
    const palette = new CommandPalette([], "selected", undefined, true);
    palette.input(query);
    expect(palette.lines(22)).toContain("   No matching actions");
    expect(palette.input("\r")).toBeUndefined();
  },
);

it("resets a resize pointer before leaving the alternate screen", () => {
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  const screen = new Screen(output);
  screen.enter();
  screen.draw({
    layout: geometry(24, 100),
    header: "Rucan",
    footer: "Palette",
    sidebarLines: ["WORKSPACES"],
    resizingSidebar: true,
    snapshot: undefined,
    showCursor: false,
  });
  expect(chunks.join("")).toContain("\x1b]22;ew-resize\x1b\\");
  screen.leave();
  expect(chunks.at(-1)).toMatch(/^\x1b\]22;\x1b\\.*\x1b\[\?1049l/u);
  output.destroy();
});
