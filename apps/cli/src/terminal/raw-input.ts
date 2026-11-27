import { InputRouter, type TerminalInput } from "./input.js";

const pasteBatchBytes = 32 * 1024;
const pasteBatchDelay = 3;

interface Handler {
  input(events: Iterable<TerminalInput>): Promise<void>;
  resize(): void;
  stop(): void;
}

/** Set terminal input state for the lifetime of a mounted view. */
export function mountRawInput(handler: Handler): () => void {
  const router = new InputRouter();
  const prior = process.stdin.isRaw;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let batch: Buffer[] = [];
  let batchBytes = 0;

  const forward = (chunk: Buffer): void => {
    process.stdin.pause();
    clearTimeout(timer);
    void handler.input(router.route(chunk)).finally(() => {
      if (!active) return;
      if (router.hasPending) {
        timer = setTimeout(() => {
          const bytes = router.takePending();
          if (bytes.length) void handler.input([{ type: "bytes", bytes }]);
        }, 18);
      }
      process.stdin.resume();
    });
  };

  const flushBatch = (): void => {
    clearTimeout(batchTimer);
    batchTimer = undefined;
    const chunk = Buffer.concat(batch, batchBytes);
    batch = [];
    batchBytes = 0;
    forward(chunk);
  };

  const data = (chunk: Buffer): void => {
    if (!router.pasting) {
      forward(chunk);
      return;
    }
    batch.push(chunk);
    batchBytes += chunk.length;
    if (batchBytes >= pasteBatchBytes) flushBatch();
    else batchTimer ??= setTimeout(flushBatch, pasteBatchDelay);
  };

  process.stdin.setRawMode(true);
  process.stdin.on("data", data);
  process.stdin.once("end", handler.stop);
  process.stdout.on("resize", handler.resize);
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
    process.once(signal, handler.stop);
  process.stdin.resume();
  return () => {
    active = false;
    clearTimeout(timer);
    clearTimeout(batchTimer);
    batch = [];
    process.stdin.off("data", data);
    process.stdin.off("end", handler.stop);
    process.stdout.off("resize", handler.resize);
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
      process.off(signal, handler.stop);
    process.stdin.pause();
    process.stdin.setRawMode(prior);
  };
}
