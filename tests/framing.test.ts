import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { decodeFrames, encodeFrame } from "../apps/cli/src/protocol/framing.js";

it("round-trips shared framing vectors with every byte arriving separately", async () => {
  const vectors = readFileSync(
    new URL("../packages/protocol/framing-vectors.txt", import.meta.url),
    "utf8",
  );
  const cases = vectors
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [kind, payload, bytes] = line.split(" ");
      if (!kind || !payload || !bytes)
        throw new Error("Invalid conformance fixture");
      return {
        kind: Number(kind),
        payload: Buffer.from(payload === "-" ? "" : payload, "hex"),
        bytes: Buffer.from(bytes, "hex"),
      };
    });
  const wire = Buffer.concat(
    cases.map(({ kind, payload, bytes }) => {
      expect(encodeFrame(kind, payload)).toEqual(bytes);
      return bytes;
    }),
  );
  const frames = [];
  for await (const frame of decodeFrames(
    Array.from(wire, (byte) => Uint8Array.of(byte)),
  )) {
    frames.push(frame);
  }
  expect(frames).toEqual(cases.map(({ kind, payload }) => ({ kind, payload })));
});

it.each(["00000000", "00100001", "0000000100", "0000000201", "0000"])(
  "rejects invalid or truncated frame %s",
  async (hex) => {
    const next = decodeFrames([Buffer.from(hex, "hex")]).next();
    await expect(next).rejects.toThrow(/Invalid|Truncated/);
  },
);
