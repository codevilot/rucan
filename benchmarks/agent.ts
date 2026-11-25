import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { SessionClient } from "../apps/cli/src/protocol/client.js";
import {
  decodeSnapshot,
  type TerminalSnapshot,
} from "../apps/cli/src/terminal/snapshot.js";
import { decodeWorkspace } from "../apps/cli/src/terminal/workspaces.js";

const exec = promisify(execFile);
const quietInterval = 2000;
const soakSeconds = Number(process.env.SSUX_BENCH_SOAK_SECONDS ?? "0");
if (!Number.isInteger(soakSeconds) || soakSeconds < 0 || soakSeconds > 86400) {
  throw new Error("SSUX_BENCH_SOAK_SECONDS must be between 0 and 86400");
}

async function descriptorCount(pid: number): Promise<number> {
  if (process.platform === "linux")
    return (await readdir(`/proc/${pid}/fd`)).length;
  const { stdout } = await exec("lsof", ["-a", "-p", String(pid), "-F", "f"], {
    maxBuffer: 1024 * 1024,
  });
  return stdout.split("\n").filter((line) => /^f\d+$/u.test(line)).length;
}

async function connect(path: string): Promise<SessionClient> {
  for (let attempt = 0; attempt < 500; attempt++) {
    try {
      return await SessionClient.connect(path);
    } catch (error) {
      if (attempt === 499) throw error;
      await delay(10);
    }
  }
  throw new Error("Agent did not start");
}

async function processMetrics(
  pid: number,
): Promise<{ rssKiB: number; cpuSeconds: number }> {
  const { stdout } = await exec("ps", [
    "-o",
    "rss=",
    "-o",
    "time=",
    "-p",
    String(pid),
  ]);
  const [rss, time = ""] = stdout.trim().split(/\s+/u);
  const cpuSeconds = time
    .split(":")
    .reduce((seconds, component) => seconds * 60 + Number(component), 0);
  return { rssKiB: Number(rss), cpuSeconds };
}

function percentile(samples: number[], fraction = 0.95): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return (
    Math.round((sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0) * 100) /
    100
  );
}

function contains(snapshot: TerminalSnapshot, value: string): boolean {
  return snapshot.grid.lines.some((line) =>
    line
      .map((span) => span[1])
      .join("")
      .includes(value),
  );
}

async function awaitText(
  client: SessionClient,
  id: string,
  initial: TerminalSnapshot,
  marker: string,
): Promise<TerminalSnapshot> {
  let state = initial;
  while (!contains(state, marker)) {
    const update = await client.request({
      type: "watch",
      session: id,
      after: state.sequence,
    });
    if (update === null) throw new Error(`Timed out waiting for ${marker}`);
    state = decodeSnapshot(update, state);
  }
  return state;
}

async function benchmark(
  path: string,
  daemon: ChildProcess,
  count: number,
  cwd: string,
  startupMs: number,
  client: SessionClient,
): Promise<void> {
  const pid = daemon.pid;
  if (!pid) throw new Error("Agent did not start");
  const baseline = await processMetrics(pid);
  const ids: string[] = [];
  const create = async (argv: string[], name: string): Promise<string> =>
    decodeWorkspace(
      await client.request({
        type: "create",
        rows: 24,
        cols: 80,
        command: "/bin/sh",
        args: argv,
        persistent: false,
        scrollback: 1000,
        name,
        cwd,
      }),
    ).id;
  for (let index = 0; index < count; index++)
    ids.push(
      await create(
        ["-c", 'while read -r line; do printf "ACK:%s\\n" "$line"; done'],
        `worker-${index}`,
      ),
    );
  await delay(200);
  const before = await processMetrics(pid);
  await delay(quietInterval);
  const idle = await processMetrics(pid);
  const switchMs: number[] = [];
  const reconnectMs: number[] = [];
  const inputMs: number[] = [];
  for (let trial = 0; trial < 35; trial++) {
    const id = ids[trial % ids.length];
    if (!id) throw new Error("Missing session");
    let start = performance.now();
    await client.request({ type: "attach", session: id });
    const snapshot = decodeSnapshot(
      await client.request({ type: "snapshot", session: id }),
    );
    await client.request({ type: "detach", session: id });
    switchMs.push(performance.now() - start);
    start = performance.now();
    const observer = await connect(path);
    try {
      decodeSnapshot(await observer.request({ type: "snapshot", session: id }));
      reconnectMs.push(performance.now() - start);
      if (trial < 15) {
        await client.request({ type: "attach", session: id });
        start = performance.now();
        await client.sendInput(id, Buffer.from(`bench-${trial}\n`));
        await awaitText(observer, id, snapshot, `ACK:bench-${trial}`);
        inputMs.push(performance.now() - start);
      }
    } finally {
      observer.close();
    }
  }

  const result: Record<string, number> = {
    sessions: count,
    startupMs: Math.round(startupMs * 100) / 100,
    rssKiB: idle.rssKiB,
    baselineKiB: baseline.rssKiB,
    idleCpuSeconds: Math.max(
      0,
      Math.round((idle.cpuSeconds - before.cpuSeconds) * 100) / 100,
    ),
    idleWindowMs: quietInterval,
    switchP95Ms: percentile(switchMs),
    reconnectP95Ms: percentile(reconnectMs),
    inputToSnapshotP95Ms: percentile(inputMs),
  };
  if (count === 1) {
    const start = performance.now();
    const fixture = await create(
      [
        "-c",
        'awk \'BEGIN { for(i=0;i<40000;i++) print "abcdefghijklmnopqrstuvwxyz0123456789"; print "THROUGHPUT-END" }\'',
      ],
      "throughput",
    );
    const snapshot = decodeSnapshot(
      await client.request({ type: "snapshot", session: fixture }),
    );
    await awaitText(client, fixture, snapshot, "THROUGHPUT-END");
    result.ptyOutputKiBPerSecond = Math.round(
      (40000 * 38) / 1024 / ((performance.now() - start) / 1000),
    );
    const folder = join(cwd, "wide");
    await mkdir(folder);
    for (let batch = 0; batch < 10; batch++) {
      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          mkdir(join(folder, `entry-${batch}-${index}`)),
        ),
      );
    }
    const directoryMs: number[] = [];
    for (let trial = 0; trial < 35; trial++) {
      const start = performance.now();
      await client.request({ type: "fs-list", path: folder, exclusions: [] });
      directoryMs.push(performance.now() - start);
    }
    result.largeDirectoryP95Ms = percentile(directoryMs);
  }
  if (count === 50 && soakSeconds) {
    result.soakSeconds = soakSeconds;
    result.soakDescriptorsBefore = await descriptorCount(pid);
    result.soakRssBeforeKiB = (await processMetrics(pid)).rssKiB;
    const end = performance.now() + soakSeconds * 1000;
    let cycles = 0;
    while (performance.now() < end) {
      const session = ids[cycles % ids.length];
      if (!session) throw new Error("Missing soak session");
      const observer = await connect(path);
      try {
        await observer.request({ type: "attach", session });
        await observer.request({ type: "snapshot", session });
        await observer.request({ type: "detach", session });
        cycles++;
      } finally {
        observer.close();
      }
      await delay(25);
    }
    await delay(200);
    result.soakCycles = cycles;
    result.soakDescriptorsAfter = await descriptorCount(pid);
    result.soakRssAfterKiB = (await processMetrics(pid)).rssKiB;
  }
  console.log(JSON.stringify(result));
}

await exec("cargo", [
  "build",
  "--locked",
  "--release",
  "-q",
  "-p",
  "ssux-agent",
]);
for (const sessions of [1, 10, 50]) {
  const directory = await mkdtemp(join(tmpdir(), "ssux-bench-"));
  const path = join(directory, "agent.sock");
  const start = performance.now();
  const daemon = spawn(
    "target/release/ssux-agent",
    ["serve", "--socket", path],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const exit = once(daemon, "exit");
  try {
    const client = await connect(path);
    try {
      await benchmark(
        path,
        daemon,
        sessions,
        directory,
        performance.now() - start,
        client,
      );
    } finally {
      client.close();
    }
  } finally {
    daemon.kill("SIGTERM");
    await exit;
    await rm(directory, { recursive: true, force: true });
  }
}

console.log(
  `Run on ${process.platform}/${process.arch}, Node ${process.version}, fixture ${basename(import.meta.url)}`,
);
