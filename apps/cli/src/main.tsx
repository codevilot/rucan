#!/usr/bin/env node
import { render } from "ink";
import { version } from "./release/version.js";
import { runDoctorCommand } from "./commands/doctor.js";
import { runUpdateCommand } from "./commands/update.js";
import { runTmuxCommand } from "./commands/tmux.js";
import { runRemoteCommand } from "./commands/remote.js";
import { runSessionCommand } from "./commands/sessions.js";
import { configPath, loadConfig } from "./config/load.js";
import { runInteractive } from "./terminal/interactive.js";
import { WorkspaceView } from "./ui/workspace.js";

async function main(args: readonly string[]): Promise<void> {
  if (args.length === 1 && args[0] === "--version") {
    console.log(`ssui ${version}`);
    return;
  }
  if (args.length === 1 && args[0] === "--help") {
    console.log(
      "Usage: ssui [attach | remote | tmux | update | doctor | config | ls | status | new | pin | unpin | detach | rename | kill | shutdown | --fixture | --help | --version]\n\nOpen the workspace UI or control a local terminal session.",
    );
    return;
  }
  if (args.length === 1 && args[0] === "config") {
    await loadConfig();
    console.log(configPath());
    return;
  }
  if (
    (await runRemoteCommand(args)) ||
    (await runTmuxCommand(args)) ||
    (await runUpdateCommand(args)) ||
    (await runDoctorCommand(args)) ||
    (await runSessionCommand(args))
  )
    return;
  if (
    args[0] === "remote" &&
    args[1] === "open" &&
    args[2] &&
    args.length <= 4
  ) {
    await runInteractive(await loadConfig(), args[3], args[2]);
    return;
  }
  if (args.length === 0 || (args.length === 2 && args[0] === "attach")) {
    const target = args[1];
    const separator = target?.indexOf(":") ?? -1;
    if (target && separator > 0) {
      await runInteractive(
        await loadConfig(),
        target.slice(separator + 1),
        target.slice(0, separator),
      );
    } else await runInteractive(await loadConfig(), target);
    return;
  }
  if (args.length !== 1 || args[0] !== "--fixture")
    throw new Error("Unknown arguments. Run ssui --help.");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("The workspace UI requires a terminal.");
  const config = await loadConfig();
  await render(<WorkspaceView config={config} />, {
    alternateScreen: true,
  }).waitUntilExit();
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(
    `ssui: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
