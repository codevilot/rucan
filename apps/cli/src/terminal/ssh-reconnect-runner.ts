import { spawn } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { ReadStream } from "node:tty";

const [, , , ...args] = process.argv;
const stop = new AbortController();
let child: ReturnType<typeof spawn> | undefined;
const terminate = (): void => {
  stop.abort();
  child?.kill("SIGTERM");
};
for (const signal of ["SIGINT", "SIGHUP", "SIGTERM"] as const) {
  process.on(signal, terminate);
}

function waitToRetry(milliseconds: number): Promise<void> {
  // Use a separate file description so the inherited SSH stdin stays blocking.
  let input: ReadStream | undefined;
  let fd: number | undefined;
  try {
    fd = openSync("/dev/tty", constants.O_RDONLY | constants.O_NONBLOCK);
    input = new ReadStream(fd);
  } catch {
    if (fd !== undefined) closeSync(fd);
    // Input-free invocations still retry on the timer.
  }
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      stop.signal.removeEventListener("abort", finish);
      if (input) {
        input.off("data", onInput);
        input.off("error", finish);
        if (!input.destroyed) input.setRawMode(false);
        input.destroy();
      }
      resolve();
    };
    const onInput = (bytes: Buffer): void => {
      if (bytes.includes(3)) stop.abort();
      else if (bytes.includes(13) || bytes.includes(10)) finish();
    };
    const timer = setTimeout(finish, milliseconds);
    stop.signal.addEventListener("abort", finish, { once: true });
    if (input) {
      // Consume retry controls here so input typed while offline cannot reach SSH authentication.
      input.setRawMode(true);
      input.once("error", finish);
      input.on("data", onInput);
      input.resume();
    }
  });
}

let retry = 1000;
while (!stop.signal.aborted) {
  const started = Date.now();
  const ssh = spawn("ssh", args, { stdio: "inherit" });
  child = ssh;
  const code = await new Promise<number>((resolve) => {
    ssh.once("error", () => {
      process.stderr.write("Could not start OpenSSH.\n");
      resolve(127);
    });
    ssh.once("close", (result) => resolve(result ?? 1));
  });
  child = undefined;
  if (stop.signal.aborted || code !== 255) {
    if (!stop.signal.aborted && code === 127) {
      const terminal = createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      try {
        await terminal.question("Press Enter to close this tab. ", {
          signal: stop.signal,
        });
      } catch {
        // A signal can close the tab while the message is displayed.
      } finally {
        terminal.close();
      }
    }
    process.exitCode = stop.signal.aborted ? 0 : code;
    break;
  }
  if (Date.now() - started > 30_000) retry = 1000;
  const seconds = Math.ceil(retry / 1000);
  // Stagger simultaneous retries from tabs that lost a shared transport.
  const waiting = waitToRetry(retry - Math.floor(Math.random() * 250));
  process.stderr.write(
    `\r\nSSH interrupted. Reconnecting in ${seconds}s · Enter retry · Ctrl+C stop\r\n`,
  );
  await waiting;
  retry = Math.min(retry * 2, 15000);
}
