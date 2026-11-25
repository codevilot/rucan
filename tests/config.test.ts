import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  configPath,
  loadConfig,
  parseConfig,
} from "../apps/cli/src/config/load.js";

describe("config", () => {
  it("uses absolute XDG paths and falls back to the home directory", () => {
    expect(configPath("/custom", "/home/dev")).toBe("/custom/ssux/config.yaml");
    expect(configPath("relative", "/home/dev")).toBe(
      "/home/dev/.config/ssux/config.yaml",
    );
  });

  it("inherits defaults while keeping host, backend and pin state independent", () => {
    const config = parseConfig(`version: 1
defaults:
  persistence: persistent
workspaces:
  - name: remote
    host: dev-server
  - name: external
    backend: tmux
    session: development
    persistence: temporary
`);
    expect(config.workspaces).toEqual([
      {
        name: "remote",
        cwd: "~",
        command: "bash",
        backend: "native",
        host: "dev-server",
        persistence: "persistent",
      },
      {
        name: "external",
        cwd: "~",
        command: "bash",
        backend: "tmux",
        session: "development",
        persistence: "temporary",
      },
    ]);
  });

  it.each([
    ["version: 2", "version"],
    ["version: 1\nextra: value", "config.extra"],
    ["version: 1\nterminal: null", "terminal"],
    [
      "version: 1\nterminal: {scrollback_lines: -1}",
      "terminal.scrollback_lines",
    ],
    ["version: 1\nterminal: {prefix_key: nope}", "terminal.prefix_key"],
    [
      "version: 1\nworkspaces: [{name: dup}, {name: dup}]",
      "workspaces[1].name",
    ],
    [
      'version: 1\nworkspaces: [{name: test, host: "-oProxyCommand"}]',
      "workspaces[0].host",
    ],
    [
      "version: 1\nworkspaces: [{name: test, session: foo}]",
      "workspaces[0].session",
    ],
    ["version: 1\nversion: 1", "unique"],
    ["version: 1\nworkspaces: [&w {name: test}, *w]", "Alias"],
  ])("rejects invalid configuration (%s)", (text, diagnostic) => {
    expect(() => parseConfig(text)).toThrow(diagnostic);
  });

  it("creates one private config with concurrent readers and preserves user edits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ssux-test-"));
    const path = join(dir, "ssux", "config.yaml");
    try {
      const [first, second] = await Promise.all([
        loadConfig(path),
        loadConfig(path),
      ]);
      expect(first).toEqual(second);
      expect(first.workspaces[0]?.name).toBe("local-shell");
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await writeFile(path, "version: 2\n");
      await expect(loadConfig(path)).rejects.toThrow(path);
      expect(await readFile(path, "utf8")).toBe("version: 2\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
