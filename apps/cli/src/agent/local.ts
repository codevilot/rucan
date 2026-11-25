import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { bundledAgent } from "./artifacts.js";
import { SessionClient } from "../protocol/client.js";

function retryable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ECONNREFUSED")
  );
}

export function localSocketPath(): string {
  const configured = process.env.SSUX_AGENT_SOCKET;
  if (configured) {
    if (!isAbsolute(configured))
      throw new Error("SSUX_AGENT_SOCKET must be absolute");
    return configured;
  }
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new Error("Native sessions currently require Unix");
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime && isAbsolute(runtime)
    ? join(runtime, "ssux", "agent.sock")
    : join("/tmp", `ssux-${uid}`, "agent.sock");
}

async function connect(path: string): Promise<SessionClient> {
  const directory = await lstat(dirname(path));
  const uid = process.getuid?.();
  if (
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error(
      `Agent socket directory is not private or owned by the current user: ${dirname(path)}`,
    );
  }
  const socket = await lstat(path);
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) {
    throw new Error(
      `Agent socket is not private or owned by the current user: ${path}`,
    );
  }
  return SessionClient.connect(path);
}

export async function connectLocalAgent(start = true): Promise<SessionClient> {
  const path = localSocketPath();
  try {
    return await connect(path);
  } catch (error) {
    if (!start || !retryable(error)) throw error;
  }

  const binary =
    process.env.SSUX_AGENT_BINARY ??
    (await bundledAgent(process.platform, process.arch))?.path ??
    fileURLToPath(
      new URL("../../../../target/debug/ssux-agent", import.meta.url),
    );
  const child = spawn(binary, ["serve", "--socket", path], {
    detached: true,
    stdio: "ignore",
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref();

  // Multiple clients can attempt startup. The agent owns the startup lock.
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await connect(path);
    } catch (error) {
      if (!retryable(error)) throw error;
      if (spawnError)
        throw new Error(`Cannot launch ${binary}. Run pnpm build.`, {
          cause: spawnError,
        });
    }
    await delay(Math.min(25 * (attempt + 1), 150));
  }
  throw new Error(`Agent did not start at ${path}`);
}
