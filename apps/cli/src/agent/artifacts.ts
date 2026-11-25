import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { version } from "../release/version.js";

export interface AgentArtifact {
  path: string;
  sha256: string;
}

export async function bundledAgent(
  os: string,
  arch: string,
): Promise<AgentArtifact | undefined> {
  if (
    !(os === "linux" || os === "darwin") ||
    !(arch === "x64" || arch === "arm64")
  ) {
    throw new Error(`Unsupported agent platform: ${os}/${arch}`);
  }
  const directory = new URL("../../agents/", import.meta.url);
  let text: string;
  try {
    text = await readFile(new URL("manifest.json", directory), "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return undefined;
    throw error;
  }
  const manifest: unknown = JSON.parse(text);
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    manifest.version !== version ||
    !("platforms" in manifest) ||
    typeof manifest.platforms !== "object" ||
    manifest.platforms === null
  ) {
    throw new Error("Invalid bundled agent manifest");
  }
  const platform = `${os}-${arch}`;
  const entries: Record<string, unknown> = { ...manifest.platforms };
  const digest = entries[platform];
  if (typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest))
    throw new Error(`Missing trusted digest for ${platform}`);
  const path = fileURLToPath(new URL(`${platform}/ssux-agent`, directory));
  const stats = await lstat(path);
  if (
    !stats.isFile() ||
    stats.size > 32 * 1024 * 1024 ||
    (stats.mode & 0o111) === 0
  ) {
    throw new Error(`Invalid bundled binary for ${platform}`);
  }
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  if (hash.digest("hex") !== digest)
    throw new Error(`Agent integrity check failed for ${platform}`);
  return { path, sha256: digest };
}
