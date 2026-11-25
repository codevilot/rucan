import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { compareVersions, stableVersion, version } from "./version.js";

const registry = "https://registry.npmjs.org";
const ttl = 6 * 60 * 60 * 1000;

interface Cache {
  checkedAt: number;
  latest?: string;
}

function directory(): string {
  const configured = process.env.XDG_CACHE_HOME;
  return join(
    configured && isAbsolute(configured)
      ? configured
      : join(homedir(), ".cache"),
    "ssui",
  );
}

async function save(name: string, contents: string): Promise<void> {
  const path = directory();
  await mkdir(path, { recursive: true, mode: 0o700 });
  const temporary = join(path, randomUUID());
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, join(path, name));
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function readCache(): Promise<Cache | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(directory(), "updates.json"), "utf8"),
    );
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("checkedAt" in raw) ||
      typeof raw.checkedAt !== "number" ||
      raw.checkedAt > Date.now() ||
      raw.checkedAt < 0
    ) {
      return undefined;
    }
    const latest = "latest" in raw ? stableVersion(raw.latest) : undefined;
    return { checkedAt: raw.checkedAt, ...(latest ? { latest } : {}) };
  } catch {
    return undefined;
  }
}

async function fetchLatest(): Promise<string | undefined> {
  const response = await fetch(`${registry}/ssui/latest`, {
    signal: AbortSignal.timeout(1800),
    headers: { accept: "application/json" },
  });
  if (!response.ok || !response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > 65536) return undefined;
      chunks.push(result.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return typeof body === "object" && body !== null && "version" in body
    ? stableVersion(body.version)
    : undefined;
}

export async function availableUpdate(
  force = false,
): Promise<string | undefined> {
  const cached = await readCache();
  let latest = cached?.latest;
  if (force || !cached || Date.now() - cached.checkedAt > ttl) {
    try {
      latest = await fetchLatest();
      await save(
        "updates.json",
        JSON.stringify({ checkedAt: Date.now(), latest }),
      ).catch(() => {});
    } catch {
      // An outage should still allow a previously cached update to be displayed.
    }
  }
  if (!latest || compareVersions(latest, version) <= 0) return undefined;
  const skip = await readFile(join(directory(), "skip-version"), "utf8").catch(
    () => "",
  );
  return !force && skip.trim() === latest ? undefined : latest;
}

export async function skipUpdate(target: string): Promise<void> {
  if (!stableVersion(target)) throw new Error("Invalid version to skip");
  await save("skip-version", target + "\n");
}

async function installMethod(): Promise<"npm" | "pnpm" | undefined> {
  const packageDirectory = await realpath(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const managers = ["npm", "pnpm"] as const;
  const results = await Promise.all(
    managers.map(async (manager) => {
      try {
        const { stdout } = await promisify(execFile)(
          manager,
          ["root", "--global"],
          {
            encoding: "utf8",
            maxBuffer: 16384,
            timeout: 2000,
          },
        );
        return (await realpath(join(stdout.trim(), "ssui"))) ===
          packageDirectory
          ? manager
          : undefined;
      } catch {
        return undefined;
      }
    }),
  );
  return results.find((manager) => manager !== undefined);
}

export async function installUpdate(target: string): Promise<void> {
  if (!stableVersion(target) || compareVersions(target, version) <= 0)
    throw new Error("Expected a newer stable version");
  const method = await installMethod();
  if (!method)
    throw new Error(
      "This installation is managed externally. Install the update using the original installation method.",
    );
  const args = [
    method === "pnpm" ? "add" : "install",
    "--global",
    "--ignore-scripts",
    `--registry=${registry}`,
    `ssui@${target}`,
  ];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(method, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Update exited with status ${code}`));
    });
  });
}
