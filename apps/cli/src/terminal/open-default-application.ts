import { spawn } from "node:child_process";

export async function openDefaultApplication(target: string): Promise<void> {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    // The desktop opener can stay alive while its application is running.
    const child = spawn(opener, [target], {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", () =>
      reject(new Error("Could not start the default application launcher.")),
    );
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
