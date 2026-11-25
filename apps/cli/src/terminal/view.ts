export type Mode =
  | "terminal"
  | "menu"
  | "palette"
  | "ssh"
  | "exit"
  | "command"
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
  prefix: string,
  name: string,
  scrollback: number,
): string {
  switch (mode) {
    case "create":
      return "Esc Menu · ↑↓ Choose workspace · Enter Open";
    case "hosts":
      return "Esc Menu · ↑↓ Select host · Enter Connect";
    case "rename":
      return `Esc Menu · Enter Save · Name ${name}`;
    case "history":
      return `Esc Menu · ↑↓ Scroll · History ${scrollback} lines back`;
    case "update":
      return "Esc Continue · 1 Update · 2 Continue · 3 Skip version";
    case "tmux":
      return "Esc Menu · ↑↓ Select · Enter Attach · N New tmux session";
    case "explorer":
      return "Esc Menu · ↑↓ Select · Enter Expand/Preview · R Refresh · O Editor";
    case "command":
      return "Esc Menu · Enter Run command";
    case "exit":
      return "Esc Menu · Enter Keep all";
    case "menu":
      return "Esc Terminal · Q Quit · ↑↓ / 1–9 Switch";
    case "palette":
      return "Esc Terminal · ↑↓ Select · Enter Run";
    case "ssh":
      return "Esc Menu · Enter Connect";
    case "terminal":
      return `${prefix} Menu (F12) · ${paletteShortcut} Search · exit Close shell`;
  }
}

export function menuFor(update?: string): string[] {
  return [
    "Workspace actions",
    "Space Search actions",
    "",
    "/exit or Q  Quit Rucan",
    "D Close UI and keep sessions",
    "",
    "N New workspace",
    "C SSH connect",
    "P Pin",
    "H Hosts",
    "E Files",
    "T Tmux",
    "S History",
    "R Rename",
    update ? `U Update to v${update}` : "U Check for updates",
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
