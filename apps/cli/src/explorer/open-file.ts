import { openDefaultApplication } from "../terminal/open-default-application.js";
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

  await openDefaultApplication(resolved);
}
