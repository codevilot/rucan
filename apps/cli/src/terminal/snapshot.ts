export type Style = readonly [
  flags: number,
  foreground: number,
  background: number,
];
export type Span = readonly [width: number, text: string, style: Style];

export interface TerminalSnapshot {
  sequence: number;
  state: "running" | "exited" | "wait-failed";
  cursor: { row: number; column: number };
  grid: {
    rows: number;
    cols: number;
    lines: Span[][];
    cursorHidden: boolean;
    applicationCursor: boolean;
    applicationKeypad: boolean;
    bracketedPaste: boolean;
    mouse: string;
    mouseEncoding: string;
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid terminal snapshot object");
  return { ...value };
}

function integer(value: unknown, low: number, high: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < low ||
    value > high
  )
    throw new Error("Invalid terminal snapshot integer");
  return value;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid terminal mode flag");
  return value;
}

function choice<const T extends string>(
  value: unknown,
  accepted: readonly T[],
): T {
  const item = accepted.find((item) => item === value);
  if (!item) throw new Error("Invalid terminal snapshot value");
  return item;
}

function decodeSpan(value: unknown): Span {
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error("Invalid terminal span");
  const [width, text, style]: unknown[] = value;
  if (
    typeof text !== "string" ||
    /\p{Cc}/u.test(text) ||
    !Array.isArray(style) ||
    style.length !== 3
  ) {
    throw new Error("Invalid terminal span text or style");
  }
  const [flags, foreground, background]: unknown[] = style;
  return [
    integer(width, 1, 500),
    text,
    [
      integer(flags, 0, 31),
      integer(foreground, -1, 0x10000ff),
      integer(background, -1, 0x10000ff),
    ],
  ];
}

export function decodeSnapshot(
  data: unknown,
  previous?: TerminalSnapshot,
): TerminalSnapshot {
  const value = record(data);
  const grid = record(value.grid);
  const cursor = record(value.cursor);
  const state = record(value.state);
  const rows = integer(grid.rows, 1, 200);
  const cols = integer(grid.cols, 1, 500);
  if (rows * cols > 12000) throw new Error("Invalid terminal grid size");
  const decodeLine = (entry: unknown): Span[] => {
    if (!Array.isArray(entry) || entry.length > cols)
      throw new Error("Invalid terminal row");
    const line = entry.map(decodeSpan);
    if (line.reduce((width, [span]) => width + span, 0) > cols)
      throw new Error("Terminal row exceeds grid");
    return line;
  };
  let lines: Span[][];
  if (Array.isArray(grid.lines) && grid.lines.length === rows) {
    lines = grid.lines.map(decodeLine);
  } else {
    if (
      !previous ||
      value.baseSequence !== previous.sequence ||
      previous.grid.rows !== rows ||
      previous.grid.cols !== cols ||
      !Array.isArray(grid.patch) ||
      grid.patch.length > rows
    ) {
      throw new Error("Terminal update requires a matching snapshot");
    }
    lines = [...previous.grid.lines];
    const seen = new Set<number>();
    for (const entry of grid.patch) {
      if (!Array.isArray(entry) || entry.length !== 2)
        throw new Error("Invalid terminal row update");
      const [index, data]: unknown[] = entry;
      const row = integer(index, 0, rows - 1);
      if (seen.has(row)) throw new Error("Duplicate terminal row update");
      seen.add(row);
      lines[row] = decodeLine(data);
    }
  }
  return {
    sequence: integer(value.sequence, 0, Number.MAX_SAFE_INTEGER),
    state: choice(state.type, ["running", "exited", "wait-failed"]),
    cursor: {
      row: integer(cursor.row, 0, rows - 1),
      column: integer(cursor.column, 0, cols),
    },
    grid: {
      rows,
      cols,
      lines,
      cursorHidden: flag(grid.cursorHidden),
      applicationCursor: flag(grid.applicationCursor),
      applicationKeypad: flag(grid.applicationKeypad),
      bracketedPaste: flag(grid.bracketedPaste),
      mouse: choice(grid.mouse, [
        "none",
        "press",
        "press-release",
        "button-motion",
        "any-motion",
      ]),
      mouseEncoding: choice(grid.mouseEncoding, ["default", "utf8", "sgr"]),
    },
  };
}
