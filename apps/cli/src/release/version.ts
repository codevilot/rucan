import { createRequire } from "node:module";

const metadata: unknown = createRequire(import.meta.url)("../../package.json");

export function stableVersion(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/u.test(value)
  )
    return undefined;
  return value;
}

function packageVersion(): string {
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "version" in metadata
  ) {
    const version = stableVersion(metadata.version);
    if (version) return version;
  }
  throw new Error("Invalid ssux package version");
}

export const version = packageVersion();

export function compareVersions(first: string, second: string): number {
  if (!stableVersion(first) || !stableVersion(second))
    throw new Error("Expected stable version numbers");
  const right = second.split(".").map(Number);
  for (const [position, left] of first.split(".").map(Number).entries()) {
    const difference = left - (right[position] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}
