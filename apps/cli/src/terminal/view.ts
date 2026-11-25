export type Mode =
  | "terminal"
  | "menu"
  | "exit"
  | "command"
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
    case "command":
      return "Enter Run command · Esc Back";
    case "exit":
      return "Enter Keep all · Esc Back";
    case "menu":
      return "Q Quit · Esc Return to terminal · ↑↓ / 1–9 Switch";
    case "terminal":
      return `${prefix} Menu (F12) · Type exit to close the current shell`;
  }
}

export function menuFor(update?: string): string[] {
  return [
    "Workspace actions",
    "",
    "/exit or Q  Quit Rucan",
    "D Close UI and keep sessions",
    "",
    "N New workspace",
    "P Pin",
    "H Hosts",
    "E Files",
    "T Tmux",
    "S History",
    "R Rename",
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
