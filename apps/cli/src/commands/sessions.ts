import { loadConfig } from "../config/load.js";
import { homedir } from "node:os";
import { basename } from "node:path";
import { connectRemoteAgent } from "../agent/ssh.js";
import { connectLocalAgent } from "../agent/local.js";

const names = new Set([
  "status",
  "ls",
  "new",
  "pin",
  "unpin",
  "kill",
  "detach",
  "rename",
  "shutdown",
]);

export async function runSessionCommand(
  args: readonly string[],
): Promise<boolean> {
  const [command, ...arguments_] = args;
  const host = arguments_[0] === "--host" ? arguments_[1] : undefined;
  if (arguments_[0] === "--host" && !host)
    throw new Error("--host requires an OpenSSH alias");
  const [argument, ...rest] = host ? arguments_.slice(2) : arguments_;
  if (!command || !names.has(command)) return false;
  if ((command === "ls" || command === "status") && argument !== undefined) {
    throw new Error(`Usage: tman ${command}`);
  }
  if (command !== "new" && command !== "rename" && rest.length > 0) {
    throw new Error(`Usage: tman ${command} [session]`);
  }

  const session = argument ?? process.env.TMAN_SESSION_ID;
  const client = host
    ? await connectRemoteAgent(host)
    : await connectLocalAgent(command === "new" || command === "ls");
  try {
    if (command === "status") {
      console.log(`${host ?? "Local agent"} connected (protocol 1)`);
    } else if (command === "ls") {
      console.log(
        JSON.stringify(await client.request({ type: "list" }), null, 2),
      );
    } else if (command === "shutdown") {
      if (argument && argument !== "--force")
        throw new Error("Usage: tman shutdown [--force]");
      console.log(
        `Stopping agent on ${host ?? "the local host"}${argument ? " and terminating managed sessions" : ""}`,
      );
      await client.request({ type: "shutdown", force: argument === "--force" });
    } else if (command === "new") {
      const config = await loadConfig();
      const shell =
        argument ?? (host ? undefined : process.env.SHELL) ?? "/bin/sh";
      const cols = Math.min(500, process.stdout.columns || 80);
      const description = await client.request({
        type: "create",
        command: shell,
        args: rest,
        cwd: host ? "~" : process.cwd() || homedir(),
        name: basename(shell),
        cols,
        rows: Math.min(
          200,
          process.stdout.rows || 24,
          Math.floor(12000 / cols),
        ),
        persistent: config.defaults.persistence === "persistent",
        scrollback: config.terminal.scrollback_lines,
      });
      console.log(JSON.stringify(description, null, 2));
    } else {
      if (!session) throw new Error(`Usage: tman ${command} <session>`);
      if (command === "kill") {
        console.log(`Stopping session ${session} on ${host ?? "local agent"}`);
        await client.request({ type: "kill", session });
      } else if (command === "detach") {
        await client.request({ type: "detach", session, force: true });
        console.log(
          `Detached input from session ${session} on ${host ?? "the local host"}`,
        );
      } else if (command === "rename") {
        if (rest.length !== 1 || !rest[0])
          throw new Error("Usage: tman rename <session> <new name>");
        console.log(
          JSON.stringify(
            await client.request({ type: "rename", session, name: rest[0] }),
            null,
            2,
          ),
        );
      } else {
        console.log(
          JSON.stringify(
            await client.request({
              type: "pin",
              session,
              persistent: command === "pin",
            }),
            null,
            2,
          ),
        );
      }
    }
  } finally {
    client.close();
  }
  return true;
}
