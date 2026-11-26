export type Mode =
  | "terminal"
  | "close"
  | "palette"
  | "ssh"
  | "explorer"
  | "tmux"
  | "update"
  | "history"
  | "rename"
  | "hosts";

export const paletteShortcut =
  process.platform === "darwin" ? "Option+Space" : "Alt+Space";

export function footerFor(
  mode: Mode,
  scrollback: number,
  canEdit = true,
): string {
  switch (mode) {
    case "hosts":
      return "Esc Palette · ↑↓ Select host · Enter Connect";
    case "rename":
      return "Esc Cancel · Enter Save";
    case "history":
      return `Esc Palette · ↑↓ Scroll · History ${scrollback} lines back`;
    case "update":
      return "Esc Continue · 1 Update · 2 Continue · 3 Skip version";
    case "tmux":
      return "Esc Palette · ↑↓ Select · Enter Attach · N New tmux session";
    case "explorer":
      return `Esc Palette · ↑↓ Select · Enter Expand/Preview · R Refresh${canEdit ? " · O Editor" : ""}`;
    case "close":
      return "Esc / Enter Cancel · Y Close";
    case "palette":
      return "Esc Terminal · ↑↓ Select · Enter Run";
    case "ssh":
      return "Esc Palette · Enter Connect";
    case "terminal":
      return `${paletteShortcut} Palette · exit Close shell`;
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
