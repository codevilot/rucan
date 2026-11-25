import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { bundledAgent } from "../agent/artifacts.js";
import { connectLocalAgent, localSocketPath } from "../agent/local.js";
import { inspectRemote } from "../agent/ssh.js";
import { configPath, loadConfig } from "../config/load.js";
import { version } from "../release/version.js";

export async function runDoctorCommand(
  args: readonly string[],
): Promise<boolean> {
  if (args[0] !== "doctor") return false;
  if (
    args.length !== 1 &&
    (args.length !== 3 || args[1] !== "--host" || !args[2])
  ) {
    throw new Error("Usage: ssui doctor [--host <alias>]");
  }
  const summary: Record<string, unknown> = {
    ssui: version,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    config: configPath(),
  };
  try {
    await loadConfig();
    summary.configurationValid = true;
  } catch (error) {
    summary.configurationError = String(error);
  }
  try {
    const { stderr } = await promisify(execFile)("ssh", ["-V"], {
      timeout: 2000,
      maxBuffer: 8192,
    });
    summary.openSsh = stderr.trim();
  } catch {
    summary.openSsh = "unavailable";
  }
  if (args[2]) summary.remote = await inspectRemote(args[2]);
  else {
    const client = await connectLocalAgent(false).catch(() => undefined);
    client?.close();
    summary.localAgent = {
      path: localSocketPath(),
      connected: Boolean(client),
    };
    try {
      summary.bundledArtifact = Boolean(
        await bundledAgent(process.platform, process.arch),
      );
    } catch (error) {
      summary.artifactError = String(error);
    }
  }
  console.log(JSON.stringify(summary, null, 2));
  return true;
}
