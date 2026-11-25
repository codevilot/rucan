import xterm from "@xterm/headless";
import { expect, it } from "vitest";
import { readVisibleGrid } from "../benchmarks/cell-grid.js";

it("projects wide RGB cells and excludes terminal side-effect sequences", async () => {
  const terminal = new xterm.Terminal({
    cols: 8,
    rows: 2,
    allowProposedApi: true,
  });
  try {
    await new Promise<void>((resolve) =>
      terminal.write(
        "\x1b[?1049h\x1b[2;3H\x1b[38;2;12;34;56m界\x1b]52;c;c2VjcmV0\x07",
        resolve,
      ),
    );
    const grid = readVisibleGrid(terminal);
    expect(grid.buffer).toBe("alternate");
    expect(grid.cursor).toEqual({ x: 4, y: 1 });
    expect(grid.rows[1]?.[2]).toEqual({
      text: "界",
      width: 2,
      foreground: { kind: "rgb", value: 0x0c2238 },
    });
    expect(grid.rows[1]?.[3]?.width).toBe(0);
    expect(
      grid.rows
        .flat()
        .map((cell) => cell.text)
        .join(""),
    ).toBe("界");
  } finally {
    terminal.dispose();
  }
});
