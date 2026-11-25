import { connectLocalAgent } from "../agent/local.js";
import { connectRemoteAgent } from "../agent/ssh.js";
import { loadConfig } from "../config/load.js";
import { runInteractive } from "../terminal/interactive.js";
import { geometry } from "../terminal/screen.js";
import { listTmux, openTmux } from "../terminal/tmux.js";

export async function runTmuxCommand(
  args: readonly string[],
): Promise<boolean> {
  if (args[0] !== "tmux") return false;
  const host = args[2] === "--host" ? args[3] : undefined;
  if (args[2] === "--host" && !host)
    throw new Error("--host requires an OpenSSH alias");
  const [target, ...overflow] = args.slice(host ? 4 : 2);
  const action = args[1];
  if (
    overflow.length ||
    !(
      (action === "ls" && !target) ||
      (action === "open" && target) ||
      (action === "new" && !target)
    )
  ) {
    throw new Error(
      "Usage: tman tmux ls | tmux open [--host <host>] <session> | tmux new [--host <host>]",
    );
  }
  if (action !== "ls" && (!process.stdin.isTTY || !process.stdout.isTTY))
    throw new Error("Opening tmux requires a terminal");
  const client = host
    ? await connectRemoteAgent(host)
    : await connectLocalAgent();
  let id: string | undefined;
  try {
    if (action === "ls")
      console.log(JSON.stringify(await listTmux(client), null, 2));
    else {
      const layout = geometry(
        process.stdout.rows || 24,
        process.stdout.columns || 80,
      );
      id = (
        await openTmux(
          client,
          layout,
          host ? "~" : process.cwd(),
          target ?? null,
        )
      ).id;
      await client.request({ type: "detach", session: id });
    }
  } finally {
    client.close();
  }
  if (id) await runInteractive(await loadConfig(), id, host);
  return true;
}
