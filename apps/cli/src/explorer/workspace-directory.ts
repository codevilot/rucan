import { posix } from "node:path";
import { connectRemoteAgent } from "../agent/ssh.js";
import type { SessionClient } from "../protocol/client.js";
import type { NativeWorkspace } from "../terminal/workspaces.js";

function absolutePath(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length <= 4096 &&
    posix.isAbsolute(value) &&
    !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}

export async function workspaceDirectory(
  client: SessionClient,
  workspace: NativeWorkspace | undefined,
  connect: () => Promise<SessionClient>,
  originHost: string | undefined,
): Promise<{
  path: string;
  connect: () => Promise<SessionClient>;
  canEdit: boolean;
}> {
  if (!workspace) throw new Error("Select a workspace before browsing files.");
  let path: string | undefined;
  let reported: string | undefined;
  if (client.supportsWorkspaceCwd) {
    const reply = await client.request({
      type: "workspace-cwd",
      session: workspace.id,
    });
    if (typeof reply !== "object" || reply === null)
      throw new Error("Invalid workspace directory response");
    path = "path" in reply ? absolutePath(reply.path) : undefined;
    reported =
      "reportedPath" in reply ? absolutePath(reply.reportedPath) : undefined;
  }
  if (workspace.sshTarget) {
    if (originHost)
      throw new Error(
        "Open an agent-backed workspace on the SSH destination to browse its files.",
      );
    if (!reported)
      throw new Error(
        "The SSH terminal has not reported its current directory.",
      );
    const target = workspace.sshTarget;
    return {
      path: reported,
      connect: () => connectRemoteAgent(target, true),
      canEdit: false,
    };
  }
  return {
    path: (workspace.backend === "tmux" ? reported : path) ?? workspace.cwd,
    connect,
    canEdit: true,
  };
}
