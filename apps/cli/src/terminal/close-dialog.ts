import type { TerminalInput } from "./input.js";
import type { Screen } from "./screen.js";

export function closeDialogLines(name: string): string[] {
  return ["Close terminal session?", name, "  Cancel", "  Close session"];
}

export function closeDialogInput(
  event: TerminalInput,
  screen: Pick<Screen, "paletteLineAt">,
): "cancel" | "close" | undefined {
  if (event.type === "mouse" && event.button === 0 && event.release) {
    const line = screen.paletteLineAt(event.row, event.col);
    if (line === 2) return "cancel";
    if (line === 3) return "close";
  }
  if (event.type !== "bytes") return undefined;
  const key = event.bytes.toString("utf8").toLowerCase();
  if (key === "y") return "close";
  if (key === "n" || key === "\x1b" || key === "\r") return "cancel";
  return undefined;
}
