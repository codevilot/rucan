import { constants } from "node:fs";
import { mkdir, open, opendir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { validSshDestination } from "./ssh-destination.js";

const maxFiles = 48;
const maxBytes = 128 * 1024;
const maxAliases = 250;

async function configText(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return "";
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer);
    return bytesRead <= maxBytes
      ? buffer.subarray(0, bytesRead).toString("utf8")
      : "";
  } finally {
    await file.close();
  }
}

function directive(
  line: string,
): { key: string; values: string[] } | undefined {
  const match = /^\s*([a-z]+)(?:\s*=\s*|\s+)(.*)$/iu.exec(line);
  if (!match?.[1] || match[2] === undefined) return;
  const result: string[] = [];
  for (const value of match[2].matchAll(
    /(#.*$)|"([^"]*)"|'([^']*)'|([^\s#]+)/gu,
  )) {
    if (value[1]) break;
    const token = value[2] ?? value[3] ?? value[4];
    if (token) result.push(token);
  }
  return { key: match[1].toLowerCase(), values: result };
}

function matchesInclude(name: string, pattern: string): boolean {
  let position = 0;
  let index = 0;
  let star = -1;
  let matched = 0;
  while (position < name.length) {
    const token = pattern[index];
    if (token === "*") {
      star = index++;
      matched = position;
    } else if (token === "?" || token === name[position]) {
      position++;
      index++;
    } else if (star >= 0) {
      index = star + 1;
      position = ++matched;
    } else return false;
  }
  while (pattern[index] === "*") index++;
  return index === pattern.length;
}

async function includePaths(pattern: string): Promise<string[]> {
  const directory = dirname(pattern);
  const filename = basename(pattern);
  if (!/[*?]/u.test(filename)) return [pattern];
  if (/[*?]/u.test(directory)) return [];
  const entries: string[] = [];
  let scanned = 0;
  for await (const entry of await opendir(directory)) {
    if (matchesInclude(entry.name, filename)) entries.push(entry.name);
    if (++scanned >= 4096) break;
  }
  return entries
    .sort()
    .slice(0, maxFiles)
    .map((entry) => join(directory, entry));
}

/** Read concrete user aliases without evaluating Match rules or commands. */
export async function sshAliases(home = homedir()): Promise<string[]> {
  const base = join(home, ".ssh");
  const seen = new Set<string>();
  const aliases = new Set<string>();
  async function visit(path: string): Promise<void> {
    if (seen.size >= maxFiles || aliases.size >= maxAliases) return;
    try {
      const canonical = await realpath(path);
      if (seen.has(canonical)) return;
      seen.add(canonical);
      for (const line of (await configText(canonical)).split("\n")) {
        const entry = directive(line);
        if (entry?.key === "host") {
          for (const name of entry.values) {
            if (
              aliases.size < maxAliases &&
              !name.includes("@") &&
              validSshDestination(name)
            )
              aliases.add(name);
          }
        } else if (entry?.key === "include") {
          for (const name of entry.values) {
            if (seen.size >= maxFiles) break;
            const path = name.startsWith("~/")
              ? resolve(home, name.slice(2))
              : isAbsolute(name)
                ? name
                : resolve(base, name);
            for (const file of await includePaths(path).catch(() => []))
              await visit(file);
          }
        }
      }
    } catch {
      // Unreadable optional SSH configurations are left out of the menu.
    }
  }
  await visit(join(base, "config"));
  return [...aliases].sort((left, right) => left.localeCompare(right));
}

export async function ensureUserSshConfig(home = homedir()): Promise<string> {
  const directory = join(home, ".ssh");
  const path = join(directory, "config");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const file = await open(path, "wx", 0o600);
    await file.close();
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
  }
  return path;
}
