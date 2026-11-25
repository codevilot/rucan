import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  link,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { parseDocument } from "yaml";
import { validateConfig, type Config } from "./schema.js";

const sample = `version: 1
defaults:
  backend: native
  persistence: temporary
  on_exit: ask
  on_disconnect: preserve
terminal:
  scrollback_lines: 10000
  prefix_key: ctrl+g
updates:
  check_on_startup: true
  channel: stable
explorer:
  exclusions: [.git, node_modules, target, .venv]
  editor:
    command: vi
    args: []
workspaces:
  - name: local-shell
    cwd: "~"
    command: bash
  # - name: gpu-server
  #   host: gpu-server
  #   cwd: "~/project"
  #   persistence: persistent
`;

export function configPath(
  xdg = process.env.XDG_CONFIG_HOME,
  home = homedir(),
): string {
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(home, ".config"),
    "rucan",
    "config.yaml",
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

async function createSample(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(path), ".config-"));
  const file = join(staging, "sample");
  try {
    await writeFile(file, sample, { mode: 0o600, flag: "wx" });
    // Publishing via link keeps concurrent readers from seeing a partial config.
    await link(file, path).catch((error: unknown) => {
      if (!hasCode(error, "EEXIST")) throw error;
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function parseConfig(text: string): Config {
  const document = parseDocument(text, { strict: true, uniqueKeys: true });
  const error = document.errors[0] ?? document.warnings[0];
  if (error) throw error;
  const data: unknown = document.toJS({ maxAliasCount: 0 });
  return validateConfig(data);
}

export async function loadConfig(path = configPath()): Promise<Config> {
  try {
    const content = await readFile(path, "utf8").catch(
      async (error: unknown) => {
        if (!hasCode(error, "ENOENT")) throw error;
        await createSample(path);
        return readFile(path, "utf8");
      },
    );
    return parseConfig(content);
  } catch (error) {
    throw new Error(
      `${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
