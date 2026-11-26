import { posix } from "node:path";
import type { SessionClient } from "../protocol/client.js";
import { validSshDestination } from "../agent/ssh-destination.js";

export type ForegroundSsh =
  | { type: "destination"; target: string; reconnect?: true }
  | { type: "unsupported" };

function decodeForegroundSsh(value: unknown): ForegroundSsh | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || !("type" in value))
    throw new Error("Invalid foreground SSH response.");
  if (value.type === "unsupported") return { type: "unsupported" };
  if (
    value.type === "destination" &&
    "target" in value &&
    typeof value.target === "string" &&
    validSshDestination(value.target)
  ) {
    return { type: "destination", target: value.target };
  }
  throw new Error("Invalid foreground SSH response.");
}

function absolutePath(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 4096 &&
    posix.isAbsolute(value) &&
    !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}

export async function workingDirectories(
  client: SessionClient,
  session: string,
): Promise<{
  path: string | undefined;
  reported: string | undefined;
  foregroundSsh: ForegroundSsh | undefined;
  supportsForegroundSsh: boolean;
}> {
  let path: string | undefined;
  let reported: string | undefined;
  let foregroundSsh: ForegroundSsh | undefined;
  let supportsForegroundSsh = false;
  if (client.supportsWorkspaceCwd) {
    const reply = await client.request({
      type: "workspace-cwd",
      session,
    });
    if (typeof reply !== "object" || reply === null)
      throw new Error("Invalid workspace directory response");
    path = "path" in reply ? absolutePath(reply.path) : undefined;
    reported =
      "reportedPath" in reply ? absolutePath(reply.reportedPath) : undefined;
    supportsForegroundSsh = "foregroundSsh" in reply;
    foregroundSsh = decodeForegroundSsh(
      "foregroundSsh" in reply ? reply.foregroundSsh : undefined,
    );
  }
  return { path, reported, foregroundSsh, supportsForegroundSsh };
}
