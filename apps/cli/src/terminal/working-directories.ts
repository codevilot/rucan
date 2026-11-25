import { posix } from "node:path";
import type { SessionClient } from "../protocol/client.js";

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
): Promise<{ path: string | undefined; reported: string | undefined }> {
  let path: string | undefined;
  let reported: string | undefined;
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
  }
  return { path, reported };
}
