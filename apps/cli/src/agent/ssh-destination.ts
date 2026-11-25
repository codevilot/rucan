import { isIP } from "node:net";

export function validSshDestination(target: string): boolean {
  if (target.length === 0 || target.length > 255) return false;
  const parts = target.split("@");
  if (parts.length > 2) return false;
  if (
    parts.length === 2 &&
    !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(parts[0] ?? "")
  )
    return false;
  const host = parts.at(-1) ?? "";
  return isIP(host) === 6 || /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(host);
}
