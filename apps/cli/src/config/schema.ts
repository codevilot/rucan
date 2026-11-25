export type Backend = "native" | "tmux";
export type Persistence = "temporary" | "persistent";

export interface WorkspaceConfig {
  name: string;
  cwd: string;
  command: string;
  backend: Backend;
  persistence: Persistence;
  host?: string;
  session?: string;
}

export interface Config {
  version: 1;
  defaults: {
    backend: Backend;
    persistence: Persistence;
    on_exit: "ask" | "keep-all" | "keep-pinned" | "terminate";
    on_disconnect: "preserve";
  };
  terminal: { scrollback_lines: number; prefix_key: string };
  updates: { check_on_startup: boolean; channel: "stable" };
  explorer: {
    exclusions: string[];
    editor: { command: string; args: string[] };
  };
  workspaces: WorkspaceConfig[];
}

function invalid(path: string, expectation: string): never {
  throw new Error(`${path}: expected ${expectation}`);
}

function record(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || !value || Array.isArray(value))
    invalid(path, "a mapping");
  const result: Record<string, unknown> = { ...value };
  for (const key of Object.keys(result)) {
    if (!keys.includes(key)) throw new Error(`${path}.${key}: unknown field`);
  }
  return result;
}

function optional(value: unknown, fallback: unknown): unknown {
  return value === undefined ? fallback : value;
}

function choice<const T extends string>(
  value: unknown,
  path: string,
  choices: readonly T[],
): T {
  return (
    choices.find((item) => item === value) ?? invalid(path, choices.join(" | "))
  );
}

function singleLine(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || /\p{Cc}/u.test(value)) {
    invalid(path, "a nonempty single-line string without control characters");
  }
  return value;
}

export function validateConfig(value: unknown): Config {
  const root = record(value, "config", [
    "version",
    "defaults",
    "terminal",
    "updates",
    "explorer",
    "workspaces",
  ]);
  if (root.version !== 1)
    invalid("version", "1 (supported configuration version)");
  const rawDefaults = record(optional(root.defaults, {}), "defaults", [
    "backend",
    "persistence",
    "on_exit",
    "on_disconnect",
  ]);
  const defaults: Config["defaults"] = {
    backend: choice(
      optional(rawDefaults.backend, "native"),
      "defaults.backend",
      ["native", "tmux"],
    ),
    persistence: choice(
      optional(rawDefaults.persistence, "temporary"),
      "defaults.persistence",
      ["temporary", "persistent"],
    ),
    on_exit: choice(optional(rawDefaults.on_exit, "ask"), "defaults.on_exit", [
      "ask",
      "keep-all",
      "keep-pinned",
      "terminate",
    ]),
    on_disconnect: choice(
      optional(rawDefaults.on_disconnect, "preserve"),
      "defaults.on_disconnect",
      ["preserve"],
    ),
  };
  const terminal = record(optional(root.terminal, {}), "terminal", [
    "scrollback_lines",
    "prefix_key",
  ]);
  const scrollback = optional(terminal.scrollback_lines, 10000);
  if (
    typeof scrollback !== "number" ||
    !Number.isInteger(scrollback) ||
    scrollback < 0 ||
    scrollback > 10000
  ) {
    invalid("terminal.scrollback_lines", "an integer from 0 to 10000");
  }
  const prefix = optional(terminal.prefix_key, "ctrl+g");
  if (typeof prefix !== "string" || !/^ctrl\+[a-z]$/.test(prefix))
    invalid("terminal.prefix_key", "ctrl+ followed by a lowercase letter");

  const updates = record(optional(root.updates, {}), "updates", [
    "check_on_startup",
    "channel",
  ]);
  const check = optional(updates.check_on_startup, true);
  if (typeof check !== "boolean")
    invalid("updates.check_on_startup", "a boolean");
  const workspaces = optional(root.workspaces, []);
  if (!Array.isArray(workspaces)) invalid("workspaces", "a sequence");
  const rawExplorer = record(optional(root.explorer, {}), "explorer", [
    "exclusions",
    "editor",
  ]);
  const editor = record(optional(rawExplorer.editor, {}), "explorer.editor", [
    "command",
    "args",
  ]);
  const allowedExclusions = optional(rawExplorer.exclusions, [
    ".git",
    "node_modules",
    "target",
    ".venv",
  ]);
  if (!Array.isArray(allowedExclusions) || allowedExclusions.length > 64)
    invalid("explorer.exclusions", "up to 64 directory names");
  const allowedEditorArgs = optional(editor.args, []);
  if (!Array.isArray(allowedEditorArgs) || allowedEditorArgs.length > 32)
    invalid("explorer.editor.args", "up to 32 arguments");
  const explorer: Config["explorer"] = {
    exclusions: allowedExclusions.map((value: unknown, index) => {
      const path = `explorer.exclusions[${index}]`;
      const name = singleLine(value, path);
      if (
        name === "." ||
        name === ".." ||
        name.includes("/") ||
        Buffer.byteLength(name) > 255
      )
        invalid(path, "a directory name");
      return name;
    }),
    editor: {
      command: singleLine(
        optional(editor.command, "vi"),
        "explorer.editor.command",
      ),
      args: allowedEditorArgs.map((value: unknown, index) =>
        singleLine(value, `explorer.editor.args[${index}]`),
      ),
    },
  };
  const names = new Set<string>();
  return {
    version: 1,
    defaults,
    explorer,
    terminal: { scrollback_lines: scrollback, prefix_key: prefix },
    updates: {
      check_on_startup: check,
      channel: choice(optional(updates.channel, "stable"), "updates.channel", [
        "stable",
      ]),
    },
    workspaces: workspaces.map((entry: unknown, index) => {
      const path = `workspaces[${index}]`;
      const item = record(entry, path, [
        "name",
        "cwd",
        "command",
        "backend",
        "persistence",
        "host",
        "session",
      ]);
      const name = singleLine(item.name, `${path}.name`);
      if (names.has(name))
        throw new Error(`${path}.name: duplicate workspace "${name}"`);
      names.add(name);
      const workspace: WorkspaceConfig = {
        name,
        cwd: singleLine(optional(item.cwd, "~"), `${path}.cwd`),
        command: singleLine(optional(item.command, "bash"), `${path}.command`),
        backend: choice(
          optional(item.backend, defaults.backend),
          `${path}.backend`,
          ["native", "tmux"],
        ),
        persistence: choice(
          optional(item.persistence, defaults.persistence),
          `${path}.persistence`,
          ["temporary", "persistent"],
        ),
      };
      if (item.host !== undefined) {
        const host = singleLine(item.host, `${path}.host`);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host))
          invalid(`${path}.host`, "an OpenSSH alias or DNS hostname");
        workspace.host = host;
      }
      if (item.session !== undefined) {
        if (workspace.backend !== "tmux")
          invalid(`${path}.session`, "a workspace with backend tmux");
        workspace.session = singleLine(item.session, `${path}.session`);
      }
      return workspace;
    }),
  };
}
