import { expect, it } from "vitest";
import { decodeSnapshot } from "../apps/cli/src/terminal/snapshot.js";

const flags = {
  rows: 2,
  cols: 4,
  cursorHidden: false,
  applicationCursor: false,
  applicationKeypad: false,
  bracketedPaste: true,
  mouse: "none",
  mouseEncoding: "default",
};
const full = {
  sequence: 5,
  state: { type: "running" },
  cursor: { row: 0, column: 1 },
  grid: { ...flags, lines: [[[1, "x", [0, -1, -1]]], []] },
};

it("applies an incremental row update only to the matching viewport", () => {
  const first = decodeSnapshot(full);
  const patch = {
    ...full,
    sequence: 6,
    baseSequence: 5,
    grid: { ...flags, patch: [[1, [[2, "界", [0, -1, -1]]]]] },
  };
  const next = decodeSnapshot(patch, first);
  expect(next.grid.lines[0]).toBe(first.grid.lines[0]);
  expect(next.grid.lines[1]?.[0]?.[1]).toBe("界");
  expect(() => decodeSnapshot({ ...patch, baseSequence: 4 }, first)).toThrow(
    "matching snapshot",
  );
});

it("rejects controls in agent-supplied terminal cells", () => {
  expect(() =>
    decodeSnapshot({
      ...full,
      grid: { ...flags, lines: [[[1, "\x1b]52;c;data\x07", [0, -1, -1]]], []] },
    }),
  ).toThrow("Invalid terminal span");
});
