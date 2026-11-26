import { connectRemoteAgent } from "../agent/ssh.js";
import type { SessionClient } from "../protocol/client.js";
import { workingDirectories } from "../terminal/working-directories.js";
import type { NativeWorkspace } from "../terminal/workspaces.js";

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
  const { path, reported } = await workingDirectories(client, workspace.id);
  if (workspace.sshTarget) {
    if (originHost)
      throw new Error(
        "Open an agent-backed workspace on the SSH destination to browse its files.",
      );
    if (!reported)
      throw new Error(
        "The SSH shell has not reported its current directory. Reopen it with SSH connect, or enable OSC 7 in the remote shell.",
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
