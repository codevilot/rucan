import { execFile } from "node:child_process";
import { open, readlink } from "node:fs/promises";
import { basename } from "node:path";
import { promisify } from "node:util";
import { validSshDestination } from "../agent/ssh-destination.js";
import { sharedSshTarget } from "./ssh-sharing.js";
import type { ForegroundSsh } from "./working-directories.js";

const run = promisify(execFile);
const maxCommand = 8192;

async function ps(args: string[]): Promise<string> {
  return (
    await run("/bin/ps", args, { timeout: 1000, maxBuffer: maxCommand })
  ).stdout.trim();
}

async function foregroundGroup(pid: number): Promise<number | undefined> {
  const [uid, group] = (
    await ps(["-p", String(pid), "-o", "uid=", "-o", "tpgid="])
  ).split(/\s+/u);
  const id = Number(group);
  if (Number(uid) === process.getuid?.() && Number.isSafeInteger(id) && id > 0)
    return id;
  return undefined;
}

async function linuxArgs(pid: number): Promise<string[]> {
  const root = `/proc/${pid}`;
  const executable = basename(await readlink(`${root}/exe`));
  if (executable !== "ssh" && executable !== "node") return [];
  const file = await open(`${root}/cmdline`, "r");
  try {
    const buffer = Buffer.alloc(maxCommand + 1);
    const { bytesRead } = await file.read(buffer);
    if (bytesRead > maxCommand || buffer[bytesRead - 1] !== 0)
      return [executable];
    return [
      executable,
      ...buffer
        .subarray(0, bytesRead - 1)
        .toString("utf8")
        .split("\0"),
    ];
  } finally {
    await file.close();
  }
}

/** Inspect a local PTY only when a compatible older agent omits foreground SSH metadata. */
export async function localForegroundSsh(
  pid: number,
): Promise<ForegroundSsh | undefined> {
  try {
    const group = await foregroundGroup(pid);
    if (!group) return;
    const fields =
      process.platform === "darwin"
        ? (
            await ps([
              "-ww",
              "-p",
              String(group),
              "-o",
              "ucomm=",
              "-o",
              "args=",
            ])
          ).split(/\s+/u)
        : await linuxArgs(group);
    const [command, executable, ...args] = fields;
    if (
      command === "node" &&
      group === pid &&
      (await foregroundGroup(pid)) === group
    ) {
      const runner = args.findIndex((arg) =>
        /(?:^|\/)ssh-reconnect-runner\.[jt]s$/u.test(arg),
      );
      const target = runner >= 0 ? args[runner + 1] : undefined;
      if (target && validSshDestination(target))
        return { type: "destination", target, reconnect: true };
    }
    if (command !== "ssh" || (await foregroundGroup(pid)) !== group) return;
    const target =
      args.length === 1
        ? args[0]
        : args.length === 2 && args[0] === "--"
          ? args[1]
          : sharedSshTarget(args);
    return executable &&
      basename(executable) === "ssh" &&
      target &&
      validSshDestination(target)
      ? { type: "destination", target }
      : { type: "unsupported" };
  } catch {
    // The session or foreground job may have ended during inspection.
    return undefined;
  }
}
