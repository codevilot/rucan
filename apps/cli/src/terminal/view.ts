export type Mode =
  | "terminal"
  | "palette"
  | "ssh"
  | "exit"
  | "explorer"
  | "tmux"
  | "update"
  | "history"
  | "rename"
  | "hosts"
  | "create";

const paletteShortcut =
  process.platform === "darwin" ? "Option+Space" : "Alt+Space";

export function footerFor(
  mode: Mode,
  name: string,
  scrollback: number,
): string {
  switch (mode) {
    case "create":
      return "Esc Palette · ↑↓ Choose workspace · Enter Open";
    case "hosts":
      return "Esc Palette · ↑↓ Select host · Enter Connect";
    case "rename":
      return `Esc Palette · Enter Save · Name ${name}`;
    case "history":
      return `Esc Palette · ↑↓ Scroll · History ${scrollback} lines back`;
    case "update":
      return "Esc Continue · 1 Update · 2 Continue · 3 Skip version";
    case "tmux":
      return "Esc Palette · ↑↓ Select · Enter Attach · N New tmux session";
    case "explorer":
      return "Esc Palette · ↑↓ Select · Enter Expand/Preview · R Refresh · O Editor";
    case "exit":
      return "Esc Palette · Enter Keep all";
    case "palette":
      return "Esc Terminal · ↑↓ Select · Enter Run";
    case "ssh":
      return "Esc Palette · Enter Connect";
    case "terminal":
      return `F12 Palette · ${paletteShortcut} Palette · exit Close shell`;
  }
}

export function selectionLines(
  title: string,
  entries: readonly string[],
  index: number,
  available: number,
): string[] {
  const start = Math.max(0, index - Math.max(0, available - 2));
  return [
    title,
    ...entries
      .slice(start)
      .map(
        (entry, offset) => `${index === start + offset ? "›" : " "} ${entry}`,
      ),
  ];
}

export function exitLines(host: string | undefined): string[] {
  return [
    "Quit Rucan",
    "",
    "Enter / 1  Close UI and keep all sessions",
    "2  Keep pinned sessions only",
    "3  Stop all Rucan-managed sessions",
    "Esc / 4  Go back",
    "",
    `Session options apply to ${host ?? "this computer"}.`,
  ];
}
