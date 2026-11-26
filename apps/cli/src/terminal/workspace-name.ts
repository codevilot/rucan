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
    !workspace.customName &&
    (defaultShellNames.has(workspace.name) ||
      workspace.name === workspace.sshTarget ||
      (workspace.name === "ssh" && workspace.sshTarget !== undefined) ||
      workspace.name === agentHost)
  );
}

export function workspaceName(
  workspace: NativeWorkspace,
  agentHost?: string,
  width?: number,
): string {
  if (!usesLocationName(workspace, agentHost)) return workspace.name;
  const host =
    workspace.location?.host ?? workspace.sshTarget ?? agentHost ?? "localhost";
  const path = workspace.location
    ? workspace.location.path
    : workspace.sshTarget
      ? undefined
      : workspace.cwd;
  const folder =
    path && posix.isAbsolute(path)
      ? (posix.basename(path) || "/").replace(/\p{Cc}/gu, "")
      : undefined;
  if (!folder) return host;
  const suffix = folder === "/" ? "/" : "/" + folder;
  if (width === undefined || stringWidth(host + suffix) <= width)
    return host + suffix;
  if (width < 5) return fit(host + suffix, width);
  const hostLength = stringWidth(host);
  const folderWidth = Math.min(
    stringWidth(suffix),
    width - hostLength >= 4 ? width - hostLength : Math.floor(width / 2),
  );
  const hostWidth = width - folderWidth;
  return (
    (stringWidth(host) > hostWidth ? fit(host, hostWidth - 1) + "…" : host) +
    fit(suffix, folderWidth)
  );
}
