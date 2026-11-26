import type { MouseEvent } from "./input.js";
import type { Geometry } from "./screen.js";
import type { TerminalSnapshot } from "./snapshot.js";

export function terminalMouse(
  event: MouseEvent,
  layout: Geometry,
  grid: TerminalSnapshot["grid"],
): Buffer | undefined {
  const col = event.col - layout.contentStart;
  const row = event.row - 1;
  if (
    col < 1 ||
    col > grid.cols ||
    row < 1 ||
    row > grid.rows ||
    grid.mouse === "none"
  )
    return undefined;
  const motion = (event.button & 32) !== 0;
  if (grid.mouse === "press" && (motion || event.release)) return undefined;
  if (grid.mouse === "press-release" && motion) return undefined;
  if (grid.mouse === "button-motion" && motion && (event.button & 3) === 3)
    return undefined;
  if (grid.mouseEncoding === "sgr") {
    return Buffer.from(
      `\x1b[<${event.button};${col};${row}${event.release ? "m" : "M"}`,
    );
  }
  const button = 32 + (event.release ? (event.button & ~3) | 3 : event.button);
  const values = [button, col + 32, row + 32];
  if (grid.mouseEncoding === "utf8")
    return Buffer.from("\x1b[M" + String.fromCodePoint(...values));
  if (values.some((value) => value > 255)) return undefined;
  return Buffer.from([0x1b, 0x5b, 0x4d, ...values]);
}
