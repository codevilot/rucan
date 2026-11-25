import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repo = "codevilot/ssux";
const workflow = "release-candidate.yml";
const registry = "https://registry.npmjs.org/";
const { version } = JSON.parse(
  readFileSync(new URL("../apps/cli/package.json", import.meta.url), "utf8"),
);
const filename = `ssux-${version}.tgz`;

function read(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function run(command, args) {
  execFileSync(command, args, { stdio: "inherit" });
}

function verify(path) {
  run("gh", [
    "attestation",
    "verify",
    path,
    "--repo",
    repo,
    "--signer-workflow",
    `${repo}/.github/workflows/${workflow}`,
  ]);
}

function listRuns(commit) {
  return JSON.parse(
    read("gh", [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      workflow,
      "--branch",
      "main",
      "--commit",
      commit,
      "--event",
      "workflow_dispatch",
      "--limit",
      "10",
      "--json",
      "databaseId,status,conclusion",
    ]),
  );
}

async function prepare(commit, destination) {
  const remote = read("git", [
    "ls-remote",
    `https://github.com/${repo}.git`,
    "refs/heads/main",
  ]).split(/\s+/u)[0];
  if (remote !== commit)
    throw new Error(
      "Check out the current published main commit before preparing a release.",
    );
  const runs = listRuns(commit);
  let candidate = runs.find(
    (item) => item.conclusion === "success" || item.status !== "completed",
  );
  if (!candidate) {
    console.log(`Starting release candidate build for ${commit.slice(0, 7)}.`);
    run("gh", ["workflow", "run", workflow, "--ref", "main", "--repo", repo]);
    const existing = new Set(runs.map((item) => item.databaseId));
    for (let attempt = 0; attempt < 20 && !candidate; attempt++) {
      await delay(3000);
      candidate = listRuns(commit).find(
        (item) => !existing.has(item.databaseId),
      );
    }
    if (!candidate)
      throw new Error(
        "Candidate run is not visible yet. Check Actions and retry.",
      );
  }
  if (candidate.status !== "completed") {
    run("gh", [
      "run",
      "watch",
      String(candidate.databaseId),
      "--repo",
      repo,
      "--exit-status",
      "--interval",
      "10",
    ]);
  }
  mkdirSync(destination, { recursive: true });
  const temporary = mkdtempSync(join(destination, ".download-"));
  try {
    run("gh", [
      "run",
      "download",
      String(candidate.databaseId),
      "--repo",
      repo,
      "--name",
      "ssux-release-candidate",
      "--dir",
      temporary,
    ]);
    const artifact = join(temporary, filename);
    verify(artifact);
    renameSync(artifact, join(destination, filename));
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  console.log(`Ready: ${join(destination, filename)}`);
}

try {
  const [action, flag, ...extra] = process.argv.slice(2);
  if (
    extra.length ||
    !(
      (action === "prepare" && !flag) ||
      (action === "publish" && (!flag || flag === "--dry-run"))
    )
  ) {
    throw new Error(
      "Usage: npm run release:prepare | npm run release:publish [-- --dry-run]",
    );
  }
  const commit = read("git", ["rev-parse", "HEAD"]);
  const destination = resolve("target", "npm-release", commit);
  if (action === "prepare") await prepare(commit, destination);
  else {
    const path = join(destination, filename);
    try {
      readFileSync(path);
    } catch {
      throw new Error("Run npm run release:prepare from this commit first.");
    }
    verify(path);
    run("npm", [
      "publish",
      path,
      "--access",
      "public",
      `--registry=${registry}`,
      ...(flag ? [flag] : []),
    ]);
  }
} catch (error) {
  console.error(
    `SSUX release: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
