import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  ensureUserSshConfig,
  sshAliases,
} from "../apps/cli/src/agent/ssh-aliases.js";

it("finds concrete aliases across includes without evaluating SSH configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "rucan-ssh-aliases-"));
  try {
    const config = await ensureUserSshConfig(home);
    expect((await stat(config)).mode & 0o777).toBe(0o600);
    const ssh = join(home, ".ssh");
    await mkdir(join(ssh, "conf.d"));
    const source = [
      'Host alpha "beta" *.example !negated # ignored',
      'Include "conf.d/*.conf"',
      "Match exec never-run-this",
      "HostName not-an-alias",
    ].join("\n");
    await writeFile(config, source);
    await writeFile(
      join(ssh, "conf.d", "second.conf"),
      "Host=gamma alpha\nInclude config\n",
    );
    await writeFile(join(ssh, "conf.d", "ignored.txt"), "Host wrong-file\n");
    expect(await sshAliases(home)).toEqual(["alpha", "beta", "gamma"]);
    expect(await ensureUserSshConfig(home)).toBe(config);
    expect(await readFile(config, "utf8")).toBe(source);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
