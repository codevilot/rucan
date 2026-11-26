import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

const extensions = new Set([
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".mpeg",
  ".mpg",
  ".webm",
  ".aac",
  ".flac",
  ".m4a",
  ".mp3",
  ".ogg",
  ".opus",
  ".wav",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".tif",
  ".tiff",
  ".webp",
  ".pdf",
]);

export function isViewableFile(path: string): boolean {
  return (
    isAbsolute(path) &&
    !/\p{Cc}/u.test(path) &&
    extensions.has(extname(path).toLowerCase())
  );
}

export async function openLocalFile(path: string): Promise<void> {
  const entry = isViewableFile(path) ? await lstat(path) : undefined;
  if (!entry?.isFile()) throw new Error("Select a local media or PDF file.");
  const resolved = await realpath(path);
  const target = await lstat(resolved);
  if (
    !isViewableFile(resolved) ||
    !target.isFile() ||
    (target.mode & 0o111) !== 0
  )
    throw new Error(
      "Only regular, non-executable media and PDF files can open.",
    );

  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    // The desktop opener can stay alive while its application is running.
    const child = spawn(opener, [resolved], {
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
