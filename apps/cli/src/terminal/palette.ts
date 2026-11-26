import type { NativeWorkspace } from "./workspaces.js";
import { paletteResultCount } from "./palette-layout.js";

export type PaletteAction =
  { kind: "command"; key: string } | { kind: "workspace"; id: string };

interface CommandEntry {
  key: string;
  label: string;
  keywords?: string;
  requiresSession?: true;
}

interface PaletteEntry {
  action: PaletteAction;
  label: string;
  keywords?: string;
}

const actions: readonly CommandEntry[] = [
  { key: "n", label: "New workspace", keywords: "new session" },
  { key: "c", label: "SSH connect", keywords: "remote host" },
  { key: "e", label: "Browse files" },
  { key: "r", label: "Rename workspace", requiresSession: true },
  { key: "d", label: "Close UI and keep sessions", keywords: "detach" },
  { key: "q", label: "Quit Rucan", keywords: "exit /exit" },
];

export class CommandPalette {
  #query = "";
  #index = 0;

  constructor(
    private readonly workspaces: readonly NativeWorkspace[],
    private readonly selected: string | undefined,
    private readonly update: string | undefined,
    private readonly sidebarVisible: boolean,
    private readonly sidebarSide: "left" | "right" = "left",
  ) {}

  #matches(): PaletteEntry[] {
    const pinned = this.workspaces.find(
      ({ id }) => id === this.selected,
    )?.persistent;
    const commands: CommandEntry[] = [
      ...actions,
      {
        key: "p",
        label: pinned ? "Unpin workspace" : "Pin workspace",
        requiresSession: true,
      },
      {
        key: "b",
        label: this.sidebarVisible ? "Hide sidebar" : "Show sidebar",
      },
      {
        key: "m",
        label: `Move sidebar to the ${this.sidebarSide === "left" ? "right" : "left"}`,
      },
      {
        key: "u",
        label: this.update
          ? `Review update to v${this.update}`
          : "Check for updates",
      },
    ];
    const workspaces: PaletteEntry[] = this.workspaces.map(
      ({ id, name }, index) => ({
        action: { kind: "workspace", id },
        label: `Switch to ${index + 1} · ${name}${id === this.selected ? " (current)" : ""}`,
      }),
    );
    const query = this.#query.trim();
    if (/^[1-9]\d?$/u.test(query))
      return workspaces.slice(Number(query) - 1, Number(query));
    const available: PaletteEntry[] = [
      ...commands
        .filter(({ requiresSession }) => !requiresSession || this.selected)
        .map(({ key, label, keywords }) => ({
          action: { kind: "command" as const, key },
          label,
          ...(keywords ? { keywords } : {}),
        })),
      ...workspaces,
    ];
    const terms = this.#query.trim().toLowerCase().split(/\s+/u);
    return available.filter(({ label, keywords }) =>
      terms.every((term) =>
        `${label} ${keywords ?? ""}`.toLowerCase().includes(term),
      ),
    );
  }

  input(key: string): PaletteAction | undefined {
    if (/^\P{Cc}+\r$/u.test(key)) {
      this.input(key.slice(0, -1));
      return this.input("\r");
    }
    if (key === "\r") return this.#matches()[this.#index]?.action;
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
    const visible = paletteResultCount(rows);
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

  actionAt(line: number, rows: number): PaletteAction | undefined {
    const index = line - 2;
    const visible = paletteResultCount(rows);
    if (index < 0 || index >= visible) return undefined;
    const first = Math.max(0, this.#index - visible + 1);
    return this.#matches()[first + index]?.action;
  }
}
