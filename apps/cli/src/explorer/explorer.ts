import { posix } from "node:path";
import type { SessionClient } from "../protocol/client.js";

interface Entry {
  name: string;
  kind: "directory" | "file" | "symlink" | "other";
}

interface Directory {
  path: string;
  entries: Entry[];
  truncated: boolean;
}

interface VisibleEntry extends Entry {
  path: string;
  depth: number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid filesystem response");
  return { ...value };
}

function decodeDirectory(value: unknown): Directory {
  const data = record(value);
  if (
    typeof data.path !== "string" ||
    !posix.isAbsolute(data.path) ||
    !Array.isArray(data.entries) ||
    data.entries.length > 500 ||
    typeof data.truncated !== "boolean"
  ) {
    throw new Error("Invalid directory listing");
  }
  const entries = data.entries.map((current: unknown): Entry => {
    const entry = record(current);
    if (
      typeof entry.name !== "string" ||
      !entry.name ||
      entry.name === "." ||
      entry.name === ".." ||
      /[/\0]/u.test(entry.name) ||
      !(
        entry.kind === "directory" ||
        entry.kind === "file" ||
        entry.kind === "symlink" ||
        entry.kind === "other"
      )
    ) {
      throw new Error("Invalid directory entry");
    }
    return { name: entry.name, kind: entry.kind };
  });
  return { path: data.path, entries, truncated: data.truncated };
}

const cacheTtl = 5000;

export class Explorer {
  #connector: () => Promise<SessionClient>;
  #canEdit = true;
  #exclusions: string[];
  #onChange: () => void;
  #connection: SessionClient | undefined;
  #generation = 0;
  #busy = false;
  #root = "~";
  #index = 0;
  #open = new Set<string>();
  #cache = new Map<string, { value: Directory; expires: number }>();
  #preview: string[] = [];
  #status = "";

  constructor(
    connector: () => Promise<SessionClient>,
    exclusions: string[],
    onChange: () => void,
  ) {
    this.#connector = connector;
    this.#exclusions = exclusions;
    this.#onChange = onChange;
  }

  enter(
    path: string,
    connector: () => Promise<SessionClient>,
    canEdit: boolean,
  ): void {
    this.leave();
    this.#connector = connector;
    this.#canEdit = canEdit;
    this.#cache.clear();
    this.#root = path;
    this.#index = 0;
    this.#open.clear();
    this.#preview = [];
    this.refresh(false);
  }

  leave(): void {
    this.#generation++;
    this.#busy = false;
    this.#connection?.close();
    this.#connection = undefined;
  }

  refresh(force = true): void {
    const root = this.#root;
    if (force) {
      this.#cache.delete(root);
      this.#open.clear();
    }
    this.#load(root, true);
  }

  move(step: number): void {
    this.#index = Math.max(
      0,
      Math.min(this.#index + step, this.#visible().length - 1),
    );
  }

  get file(): string | undefined {
    const entry = this.#visible()[this.#index];
    return entry?.kind === "file" ? entry.path : undefined;
  }

  get canEdit(): boolean {
    return this.#canEdit;
  }

  activate(): void {
    const entry = this.#visible()[this.#index];
    if (!entry) return;
    if (entry.kind === "directory") {
      if (this.#open.delete(entry.path)) this.#onChange();
      else this.#load(entry.path, false);
    } else if (entry.kind === "file") {
      this.#fetch(async (client) => {
        const preview = record(
          await client.request({ type: "fs-preview", path: entry.path }),
        );
        if (
          typeof preview.text !== "string" ||
          typeof preview.binary !== "boolean" ||
          typeof preview.truncated !== "boolean"
        ) {
          throw new Error("Invalid file preview");
        }
        const text = preview.text;
        return () => {
          this.#preview = [
            entry.path,
            ...(preview.binary ? ["Binary file"] : text.split("\n")),
          ];
          this.#status =
            preview.truncated === true ? "Preview limited to 64 KiB" : "";
        };
      });
    }
  }

  layout(height: number): {
    sidebar: string[];
    content: string[];
    canEdit: boolean;
  } {
    const rows = this.#visible();
    const first = Math.max(0, this.#index - Math.max(0, height - 5));
    const entries = rows
      .slice(first, first + Math.max(1, height - 3))
      .map((entry, offset) => {
        const selection = first + offset === this.#index ? "›" : " ";
        const kind =
          entry.kind === "directory"
            ? this.#open.has(entry.path)
              ? "▾ "
              : "▸ "
            : entry.kind === "symlink"
              ? "↗ "
              : "  ";
        return (
          selection + " ".repeat(Math.min(entry.depth, 20)) + kind + entry.name
        );
      });
    return {
      sidebar: ["EXPLORER", this.#root, ...entries],
      content: [this.#status, ...this.#preview],
      canEdit: this.#canEdit,
    };
  }

  #visible(): VisibleEntry[] {
    const rows: VisibleEntry[] = [];
    const visit = (path: string, depth: number): void => {
      if (depth >= 64) return;
      for (const entry of this.#cache.get(path)?.value.entries ?? []) {
        const nested = posix.join(path, entry.name);
        rows.push({ ...entry, path: nested, depth });
        if (this.#open.has(nested)) visit(nested, depth + 1);
      }
    };
    visit(this.#root, 0);
    return rows;
  }

  #load(path: string, root: boolean): void {
    const use = (directory: Directory): void => {
      if (root) this.#root = directory.path;
      else this.#open.add(directory.path);
      this.#status = directory.truncated
        ? "Directory listing limited to 500 entries"
        : "";
    };
    const cached = this.#cache.get(path);
    if (cached && cached.expires > Date.now()) {
      use(cached.value);
      this.#onChange();
      return;
    }
    this.#fetch(async (client) => {
      const directory = decodeDirectory(
        await client.request({
          type: "fs-list",
          path,
          exclusions: this.#exclusions,
        }),
      );
      return () => {
        this.#cache.delete(directory.path);
        this.#cache.set(directory.path, {
          value: directory,
          expires: Date.now() + cacheTtl,
        });
        while (this.#cache.size > 48) {
          const first = [...this.#cache.keys()].find(
            (key) => key !== this.#root && key !== directory.path,
          );
          if (first === undefined) break;
          this.#cache.delete(first);
          this.#open.delete(first);
        }
        use(directory);
      };
    });
  }

  #fetch(operation: (client: SessionClient) => Promise<() => void>): void {
    if (this.#busy) this.leave();
    this.#busy = true;
    const revision = this.#generation;
    this.#status = "Loading";
    this.#onChange();
    void (async () => {
      let connection: SessionClient | undefined;
      try {
        connection =
          this.#connection?.closed === false
            ? this.#connection
            : await this.#connector();
        if (revision !== this.#generation) {
          connection.close();
          return;
        }
        this.#connection = connection;
        const apply = await operation(connection);
        if (revision === this.#generation) apply();
      } catch (error) {
        if (revision === this.#generation)
          this.#status = error instanceof Error ? error.message : String(error);
      } finally {
        if (revision === this.#generation) {
          this.#busy = false;
          this.#onChange();
        }
      }
    })();
  }
}
