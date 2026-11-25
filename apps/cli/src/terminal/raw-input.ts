import { InputRouter, type TerminalInput } from "./input.js";

interface Handler {
  input(events: Iterable<TerminalInput>): Promise<void>;
  resize(): void;
  stop(): void;
}

/** Set terminal input state for the lifetime of a mounted view. */
export function mountRawInput(prefix: string, handler: Handler): () => void {
  const router = new InputRouter(prefix);
  const prior = process.stdin.isRaw;
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const data = (chunk: Buffer): void => {
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
    process.stdin.off("data", data);
    process.stdin.off("end", handler.stop);
    process.stdout.off("resize", handler.resize);
    for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const)
      process.off(signal, handler.stop);
    process.stdin.pause();
    process.stdin.setRawMode(prior);
  };
}
