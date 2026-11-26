import { paletteResultCount } from "./palette-layout.js";

export type WorkspaceLaunch =
  { type: "local" } | { type: "ssh"; host: string } | { type: "edit-ssh" };

export class WorkspaceLauncher {
  #index = 0;
  #query = "";
  readonly #items: { label: string; action: WorkspaceLaunch }[];

  constructor(aliases: readonly string[]) {
    this.#items = [
      { label: "localhost", action: { type: "local" } },
      { label: "Edit SSH config", action: { type: "edit-ssh" } },
      ...aliases.map((host) => ({
        label: `SSH · ${host}`,
        action: { type: "ssh" as const, host },
      })),
    ];
  }

  #matches() {
    const query = this.#query.trim().toLowerCase();
    return this.#items.filter(({ label }) =>
      label.toLowerCase().includes(query),
    );
  }

  #start(rows: number): number {
    return Math.max(0, this.#index - paletteResultCount(rows) + 1);
  }

  lines(rows: number): string[] {
    const start = this.#start(rows);
    const matches = this.#matches().slice(
      start,
      start + paletteResultCount(rows),
    );
    return [
      "New workspace",
      this.#query ? `${this.#query}▏` : "Type to filter SSH aliases",
      ...(matches.length
        ? matches.map(
            ({ label }, index) =>
              `${start + index === this.#index ? "›" : " "}  ${label}`,
          )
        : ["   No matching workspaces"]),
    ];
  }

  actionAt(line: number, rows: number): WorkspaceLaunch | undefined {
    if (line < 2 || line >= 2 + paletteResultCount(rows)) return;
    return this.#matches()[this.#start(rows) + line - 2]?.action;
  }

  input(key: string): WorkspaceLaunch | undefined {
    if (/^\P{Cc}+\r$/u.test(key)) {
      this.input(key.slice(0, -1));
      return this.input("\r");
    }
    if (key === "\r") return this.#matches()[this.#index]?.action;
    if (key === "\x1b[A") this.#index = Math.max(0, this.#index - 1);
    else if (key === "\x1b[B")
      this.#index = Math.max(
        0,
        Math.min(this.#matches().length - 1, this.#index + 1),
      );
    else if (key === "\x7f") {
      this.#query = [...this.#query].slice(0, -1).join("");
      this.#index = 0;
    } else if (!/\p{Cc}/u.test(key) && this.#query.length + key.length <= 128) {
      this.#query += key;
      this.#index = 0;
    }
    return undefined;
  }
}
