import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import { SessionClient } from "../protocol/client.js";

export interface RemotePlatform {
  os: "linux" | "darwin";
  arch: "x64" | "arm64";
  runtime: string;
  loginManager: string;
}

const commonSshArguments = [
  "-T",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=2",
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
];
const remotePaths =
  'bin="$HOME/.local/lib/ssux/ssux-agent"; socket="/tmp/ssux-$(id -u)/agent.sock"';
const bridge = `${remotePaths}
if [ ! -x "$bin" ]; then
  printf '%s\\n' 'ssux-agent is missing; install a verified binary with ssux remote install' >&2
  exit 127
fi
exec "$bin" connect --socket "$socket"`;
const detect = `
uname -s
uname -m
if [ "$(uname -s)" = Linux ]; then
  { getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version; } 2>&1 | head -n 1
  if command -v loginctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    loginctl show-user "$(id -un)" --value -p Linger 2>/dev/null || printf '%s\\n' unknown
  else
    printf '%s\\n' unmanaged
  fi
else
  sw_vers -productVersion
  printf '%s\\n' launchd
fi`;

export function validSshHost(host: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(host);
}

function sshArguments(host: string, script: string): string[] {
  if (!validSshHost(host))
    throw new Error("Expected an OpenSSH alias or DNS hostname");
  const quoted = "'" + script.replaceAll("'", "'\\''") + "'";
  const config = process.env.SSUX_SSH_CONFIG;
  if (config && !isAbsolute(config))
    throw new Error("SSUX_SSH_CONFIG must be absolute");
  const options = config ? ["-F", config] : [];
  return [...commonSshArguments, ...options, "--", host, `sh -c ${quoted}`];
}

export async function inspectRemote(host: string): Promise<RemotePlatform> {
  const { stdout } = await promisify(execFile)(
    "ssh",
    sshArguments(host, detect),
    {
      encoding: "utf8",
      maxBuffer: 32768,
      timeout: 10000,
    },
  );
  const [system, machine, runtime = "unknown", loginManager = "unknown"] =
    stdout.trim().split("\n");
  const os =
    system === "Linux" ? "linux" : system === "Darwin" ? "darwin" : undefined;
  const arch =
    machine === "x86_64"
      ? "x64"
      : machine === "arm64" || machine === "aarch64"
        ? "arm64"
        : undefined;
  if (!os || !arch)
    throw new Error(
      `Unsupported remote platform: ${system ?? "unknown"} ${machine ?? "unknown"}`,
    );
  return { os, arch, runtime, loginManager };
}

export async function connectRemoteAgent(host: string): Promise<SessionClient> {
  const child = spawn("ssh", sshArguments(host, bridge), {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  let diagnostic = "";
  child.stderr.on("data", (chunk: Buffer) => {
    if (diagnostic.length < 4096)
      diagnostic += chunk.toString("utf8").slice(0, 4096 - diagnostic.length);
  });
  child.on("error", (error) => stream.destroy(error));
  stream.once("close", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  try {
    return await SessionClient.negotiate(stream, 12000);
  } catch (error) {
    const detail = diagnostic
      .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/gu, "")
      .trim();
    throw new Error(`Cannot connect to ${host}${detail ? `: ${detail}` : ""}`, {
      cause: error,
    });
  }
}

export async function installRemote(
  host: string,
  path: string,
  expectedHash: string,
  knownPlatform?: RemotePlatform,
): Promise<RemotePlatform> {
  const digest = expectedHash.toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(digest))
    throw new Error("Expected a trusted SHA-256 digest");
  const file = await open(path, "r");
  let artifact: Buffer;
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size < 1 || stats.size > 32 * 1024 * 1024)
      throw new Error("Expected a regular agent artifact up to 32 MiB");
    artifact = Buffer.alloc(stats.size + 1);
    let received = 0;
    while (received < artifact.length) {
      const read = await file.read(artifact, received);
      if (read.bytesRead === 0) break;
      received += read.bytesRead;
    }
    if (received !== stats.size)
      throw new Error("Agent artifact changed while reading");
    artifact = artifact.subarray(0, received);
  } finally {
    await file.close();
  }
  if (createHash("sha256").update(artifact).digest("hex") !== digest)
    throw new Error("Agent artifact SHA-256 mismatch");
  const platform = knownPlatform ?? (await inspectRemote(host));
  const transfer = `set -eu
umask 077
${remotePaths}
directory=${"$"}{bin%/*}
mkdir -p "$directory"
tmp=$(mktemp "$directory/.agent.XXXXXXXX")
trap 'unlink "$tmp" 2>/dev/null || :' EXIT HUP INT TERM
cat > "$tmp"
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp")
else
  actual=$(shasum -a 256 "$tmp")
fi
[ "${"$"}{actual%% *}" = '${digest}' ] || { printf '%s\\n' 'agent SHA-256 mismatch' >&2; exit 1; }
chmod 700 "$tmp"
"$tmp" --version
if [ -e "$bin" ]; then
  cmp -s "$tmp" "$bin" && exit 0
  printf '%s\\n' 'an existing agent artifact differs; stop sessions and remove or archive the old binary explicitly before upgrading' >&2
  exit 1
fi
ln "$tmp" "$bin"`;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ssh", sshArguments(host, transfer), {
      stdio: ["pipe", "inherit", "inherit"],
      timeout: 30_000,
    });
    child.once("error", reject);
    child.stdin.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`Agent installation on ${host} exited with status ${code}`),
        );
    });
    child.stdin.end(artifact);
  });
  return platform;
}
