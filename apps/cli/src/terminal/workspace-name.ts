import { posix } from "node:path";
import stringWidth from "string-width";
import { fit } from "./chrome.js";
import type { NativeWorkspace } from "./workspaces.js";

const defaultShellNames = new Set([
  "local-shell",
  "sh",
  "bash",
  "zsh",
  "fish",
  "dash",
  "ksh",
  "tcsh",
  "csh",
]);

export function usesLocationName(
  workspace: NativeWorkspace,
  agentHost?: string,
): boolean {
  return (
    workspace.backend === "native" &&
    (workspace.customName === false ||
      (workspace.customName === undefined &&
        (defaultShellNames.has(workspace.name) ||
          workspace.name === workspace.sshTarget ||
          (workspace.name === "ssh" && workspace.sshTarget !== undefined) ||
          workspace.name === agentHost)))
  );
}

export function workspaceName(
  workspace: NativeWorkspace,
  agentHost?: string,
  width?: number,
): string {
  if (!usesLocationName(workspace, agentHost)) return workspace.name;
  const destination =
    workspace.location?.host ?? workspace.sshTarget ?? agentHost ?? "localhost";
  const host = destination.split("@").at(-1) ?? destination;
  const address = "[" + host + "]";
  const path = workspace.location
    ? workspace.location.path
    : workspace.sshTarget
      ? undefined
      : workspace.cwd;
  const folder =
    path && posix.isAbsolute(path)
      ? (posix.basename(path) || "/").replace(/\p{Cc}/gu, "")
      : undefined;
  if (!folder) return address;
  const separator = " / ";
  const full = address + separator + folder;
  if (width === undefined || stringWidth(full) <= width) return full;
  if (width < 8) return fit(full, width);
  const remaining = width - 2 - separator.length;
  const hostLength = stringWidth(host);
  const folderWidth = Math.min(
    stringWidth(folder),
    remaining - hostLength >= 3
      ? remaining - hostLength
      : Math.floor(remaining / 2),
  );
  const hostWidth = remaining - folderWidth;
  const shortHost =
    hostLength > hostWidth ? fit(host, hostWidth - 1) + "…" : host;
  return "[" + shortHost + "]" + separator + fit(folder, folderWidth);
}
