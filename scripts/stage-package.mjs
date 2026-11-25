import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";

const [artifactRoot, requestedOutput] = process.argv.slice(2);
if (!artifactRoot || !requestedOutput)
  throw new Error(
    "Usage: node scripts/stage-package.mjs <artifacts> <staging-directory>",
  );

const output = resolve(requestedOutput);
if (existsSync(output)) throw new Error("Staging directory must be new");
const metadata = JSON.parse(readFileSync("apps/cli/package.json", "utf8"));
const cargo = JSON.parse(
  execFileSync(
    "cargo",
    ["metadata", "--locked", "--no-deps", "--format-version=1"],
    { encoding: "utf8" },
  ),
);
const agentVersion = cargo.packages.find(
  ({ name }) => name === "ssui-agent",
)?.version;
if (metadata.version !== agentVersion)
  throw new Error("Agent and CLI versions must match");

function validatePlatform(platform, binary) {
  if (binary.length < 64) throw new Error(`Truncated artifact for ${platform}`);
  const x64 = platform.endsWith("-x64");
  const matches = platform.startsWith("linux-")
    ? binary.readUInt32BE(0) === 0x7f454c46 &&
      binary[4] === 2 &&
      binary[5] === 1 &&
      binary.readUInt16LE(18) === (x64 ? 62 : 183)
    : binary.readUInt32LE(0) === 0xfeedfacf &&
      binary.readUInt32LE(4) === (x64 ? 0x01000007 : 0x0100000c);
  if (!matches) throw new Error(`Binary architecture mismatch for ${platform}`);
}

const bundled = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"];
const platforms = {};
mkdirSync(join(output, "agents"), { recursive: true });
for (const platform of bundled) {
  const source = join(artifactRoot, platform, "ssui-agent");
  const payload = readFileSync(source);
  validatePlatform(platform, payload);
  const directory = join(output, "agents", platform);
  mkdirSync(directory);
  const binary = join(directory, "ssui-agent");
  writeFileSync(binary, payload, { mode: 0o755 });
  platforms[platform] = createHash("sha256").update(payload).digest("hex");
}
writeFileSync(
  join(output, "agents", "manifest.json"),
  JSON.stringify({ version: metadata.version, platforms }, null, 2) + "\n",
);
cpSync("apps/cli/dist", join(output, "dist"), { recursive: true });
chmodSync(join(output, "dist", "main.js"), 0o755);
cpSync("README.md", join(output, "README.md"));
cpSync("LICENSE", join(output, "LICENSE"));
cpSync("NOTICE", join(output, "NOTICE"));
execFileSync(
  "python3",
  [
    "scripts/collect-rust-notices.py",
    join(output, "agents", "THIRD_PARTY_LICENSES.txt"),
  ],
  { stdio: "inherit" },
);
delete metadata.private;
writeFileSync(
  join(output, "package.json"),
  JSON.stringify(metadata, null, 2) + "\n",
);
