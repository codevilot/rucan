import { bundledAgent } from "../agent/artifacts.js";
import {
  connectRemoteAgent,
  inspectRemote,
  installRemote,
} from "../agent/ssh.js";

export async function runRemoteCommand(
  args: readonly string[],
): Promise<boolean> {
  const [category, command, host, artifact, hash] = args;
  if (category !== "remote" || command === "open") return false;
  if (command === "inspect" && host && args.length === 3) {
    console.log(JSON.stringify(await inspectRemote(host), null, 2));
  } else if (
    command === "install" &&
    host &&
    (args.length === 3 || (artifact && hash && args.length === 5))
  ) {
    // Invoking install with an explicit host and trusted digest is the installation approval.
    const supplied =
      artifact && hash ? { path: artifact, sha256: hash } : undefined;
    const target = await inspectRemote(host);
    const selected = supplied ?? (await bundledAgent(target.os, target.arch));
    if (!selected)
      throw new Error(
        "No bundled artifact. Provide a binary and trusted SHA-256 digest.",
      );
    const platform = await installRemote(
      host,
      selected.path,
      selected.sha256,
      target,
    );
    const client = await connectRemoteAgent(host);
    client.close();
    console.log(`Agent ready on ${host} (${platform.os}/${platform.arch}).`);
  } else {
    throw new Error(
      "Usage: rucan remote inspect <host> | remote install <host> [<binary> <trusted-sha256>] | remote open <host> [session]",
    );
  }
  return true;
}
