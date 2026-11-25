interface PaletteAction {
  key: string;
  label: string;
  requiresSession?: true;
}

const actions: readonly PaletteAction[] = [
  { key: "n", label: "New workspace" },
  { key: "c", label: "SSH connect" },
  { key: "e", label: "Browse files" },
  { key: "h", label: "Switch host" },
  { key: "t", label: "Manage tmux sessions" },
  { key: "p", label: "Pin workspace", requiresSession: true },
  { key: "s", label: "View terminal history", requiresSession: true },
  { key: "r", label: "Rename workspace", requiresSession: true },
  { key: "d", label: "Close UI and keep sessions" },
  { key: "q", label: "Quit Rucan" },
];

export class CommandPalette {
  #query = "";
  #index = 0;

  constructor(
    private readonly hasSession: boolean,
    private readonly update: string | undefined,
  ) {}

  #matches(): PaletteAction[] {
    const available = this.update
      ? [...actions, { key: "u", label: `Review update to v${this.update}` }]
      : actions;
    const terms = this.#query.trim().toLowerCase().split(/\s+/u);
    return available.filter(
      ({ label, requiresSession }) =>
        (!requiresSession || this.hasSession) &&
        terms.every((term) => label.toLowerCase().includes(term)),
    );
  }

  input(key: string): string | undefined {
    if (key === "\r") return this.#matches()[this.#index]?.key;
    if (key === "\x1b[A" || key === "\x1b[B") {
      const step = key === "\x1b[A" ? -1 : 1;
      this.#index = Math.max(
        0,
        Math.min(this.#index + step, this.#matches().length - 1),
      );
    } else if (key === "\x7f") {
      this.#query = [...this.#query].slice(0, -1).join("");
      this.#index = 0;
    } else if (/^\P{Cc}+$/u.test(key)) {
      this.#query = [...(this.#query + key)].slice(0, 64).join("");
      this.#index = 0;
    }
    return undefined;
  }

  lines(rows: number): string[] {
    const matches = this.#matches();
    const visible = Math.max(1, Math.min(7, rows - 2));
    const first = Math.max(0, this.#index - visible + 1);
    return [
      "◆  Rucan commands",
      `⌕  ${this.#query || "Search actions"}▏`,
      ...(matches.length
        ? matches
            .slice(first, first + visible)
            .map(({ label }, index) =>
              index + first === this.#index ? `›  ${label}` : `   ${label}`,
            )
        : ["   No matching actions"]),
    ];
  }
}
