import { Writable } from "node:stream";
import { once } from "node:events";
import xterm from "@xterm/headless";
import { expect, it } from "vitest";
import { CommandPalette } from "../apps/cli/src/terminal/palette.js";
import { paletteBounds } from "../apps/cli/src/terminal/palette-layout.js";
import { geometry, Screen } from "../apps/cli/src/terminal/screen.js";

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
      sidebarLines: ["WORKSPACES", "↗ SSH connect"],
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
    for (const [rows, cols] of [
      [24, 100],
      [15, 42],
      [30, 118],
    ] as const) {
      terminal.resize(cols, rows);
      layout = geometry(rows, cols);
      const open = await render(true);
      const { top, left } = paletteBounds(layout);
      expect(
        open.filter((line) => line.includes("Rucan commands")),
      ).toHaveLength(1);
      expect(open[top - 1]).toContain("Rucan commands");
      expect(open.some((line) => line.includes("New workspace"))).toBe(true);

      palette.input("ssh");
      const filtered = await render(true);
      expect(
        filtered.filter((line) => line.includes("Rucan commands")),
      ).toHaveLength(1);
      expect(filtered.some((line) => line.includes("New workspace"))).toBe(
        false,
      );
      expect(filtered[top + 1]).toContain("SSH connect");
      const hit = screen.paletteLineAt(top + 2, left);
      expect(hit).toBe(2);
      expect(palette.actionAt(hit ?? -1, rows - 2)).toEqual({
        kind: "command",
        key: "c",
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
      for (let i = 0; i < 4; i++) palette.input("\x7f");
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
