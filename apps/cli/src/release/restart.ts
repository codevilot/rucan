import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installUpdate, registry } from "./updates.js";
import { compareVersions, stableVersion, version } from "./version.js";

export async function restartAfterUpdate(
  target: string,
  host: string | undefined,
  session: string | undefined,
): Promise<void> {
  if (!stableVersion(target) || compareVersions(target, version) <= 0)
    throw new Error("Expected a newer stable version");

  const folder = await realpath(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const modules = dirname(folder);
  const fromNpx =
    basename(modules) === "node_modules" &&
    basename(dirname(dirname(modules))) === "_npx";
  const open = host ? ["remote", "open", host] : [];
  let command = process.execPath;
  let args: string[];
  if (fromNpx) {
    command = "npm";
    args = [
      "exec",
      "--yes",
      "--prefer-online",
      "--ignore-scripts",
      `--registry=${registry}`,
      `--package=rucan@${target}`,
      "--",
      "rucan",
      ...open,
    ];
  } else {
    args = [await installUpdate(target), ...open];
  }

  const env = { ...process.env, RUCAN_RESUME_SESSION: session };
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Updated Rucan exited with ${signal ?? code}`));
    });
  });
}
