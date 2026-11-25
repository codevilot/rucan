export type Mode =
  | "terminal"
  | "menu"
  | "exit"
  | "explorer"
  | "tmux"
  | "update"
  | "history"
  | "rename"
  | "hosts"
  | "create";

export function footerFor(
  mode: Mode,
  prefix: string,
  name: string,
  scrollback: number,
  update?: string,
): string {
  switch (mode) {
    case "create":
      return "↑↓ Choose workspace · Enter Open · Esc Back";
    case "hosts":
      return "↑↓ Select host · Enter Connect · Esc Back";
    case "rename":
      return `Rename workspace: ${name} · Enter Save · Esc Cancel`;
    case "history":
      return `History · ${scrollback} lines back · ↑↓ Scroll · Esc Back`;
    case "update":
      return "1 Update now · 2 Continue · 3 Skip this version";
    case "tmux":
      return "↑↓ Select · Enter Attach · N Open New Tmux Session · Esc Back";
    case "explorer":
      return "↑↓ Select · Enter Expand/Preview · R Refresh · O Editor · Esc Back";
    case "exit":
      return "1 Keep all · 2 Keep pinned · 3 Stop managed · 4 Cancel";
    case "menu":
      return "↑↓ / 1–9 Switch · N New · P Pin · H Hosts · D Detach · Q Quit";
    case "terminal":
      return `${prefix} Menu${update ? ` · Update v${update} available` : ""}`;
  }
}

export function menuFor(update?: string): string[] {
  return [
    "N New",
    "P Pin",
    "H Hosts",
    "E Files",
    "T Tmux",
    "S History",
    "R Rename",
    "D Detach",
    "Q Quit",
    ...(update ? [`U Update to v${update}`] : []),
  ];
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
