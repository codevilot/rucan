import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { localSocketPath } from "../agent/local.js";

const master = "ControlMaster=auto";
const persist = "ControlPersist=60";
const pathOption = "ControlPath=";
const managedPath = /^ControlPath=\/tmp\/rucan-ssh-\d+-[a-f0-9]{16}\/%C$/u;

/** OpenSSH owns the connections and expires idle masters. Rucan owns the private directory. */
export async function sshSharingArgs(
  target: string,
  reconnect = false,
): Promise<string[]> {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("SSH connection sharing requires Unix.");
  const key = createHash("sha256")
    .update(localSocketPath())
    .update("\0")
    .update(target)
    .update(reconnect ? "\0resume" : "")
    .digest("hex")
    .slice(0, 16);
  const directory = `/tmp/rucan-ssh-${uid}-${key}`;
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  }
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0)
    throw new Error(
      "The SSH sharing directory must be private and owned by the current user.",
    );
  return ["-o", master, "-o", persist, "-o", `${pathOption}${directory}/%C`];
}

/** Recognize Rucan's own argv when an older agent does not report SSH metadata. */
export function sharedSshTarget(args: readonly string[]): string | undefined {
  const [
    flag,
    mode,
    persistenceFlag,
    persistence,
    pathFlag,
    path,
    hostFlag,
    verification,
    ...rest
  ] = args;
  if (
    flag !== "-o" ||
    mode !== master ||
    persistenceFlag !== "-o" ||
    persistence !== persist ||
    pathFlag !== "-o" ||
    !path ||
    !managedPath.test(path) ||
    hostFlag !== "-o" ||
    verification !== "StrictHostKeyChecking=ask"
  )
    return;
  if (rest[0] === "--" && rest.length === 2) return rest[1];
  if (rest[0] === "-t" && rest[1] === "--" && rest.length >= 4) return rest[2];
  return undefined;
}
