import { availableUpdate, installUpdate } from "../release/updates.js";
import { version } from "../release/version.js";

export async function runUpdateCommand(
  args: readonly string[],
): Promise<boolean> {
  if (args[0] !== "update") return false;
  const apply = args.length === 2 && args[1] === "--apply";
  if (!apply && args.length !== 1)
    throw new Error("Usage: tman update [--apply]");
  const target = await availableUpdate(true);
  if (!target)
    console.log(`No newer stable release found (installed v${version}).`);
  else if (apply) await installUpdate(target);
  else
    console.log(
      `Update available: v${version} → v${target}\nRun tman update --apply to install.`,
    );
  return true;
}
