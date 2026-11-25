export const maxFrameBytes = 1024 * 1024;

export interface Frame {
  kind: number;
  payload: Buffer;
}

function validateLength(length: number): void {
  if (length < 1 || length > maxFrameBytes) {
    throw new Error(`Invalid IPC frame length ${length}`);
  }
}

export function encodeFrame(kind: number, payload: Uint8Array): Buffer {
  if (!Number.isInteger(kind) || kind < 1 || kind > 255) {
    throw new Error(`Invalid IPC frame kind ${kind}`);
  }
  const length = payload.length + 1;
  validateLength(length);
  const bytes = Buffer.allocUnsafe(length + 4);
  bytes.writeUInt32BE(length);
  bytes[4] = kind;
  bytes.set(payload, 5);
  return bytes;
}

/** Read frames as the consumer requests them. Each frame owns its bounded body. */
export async function* decodeFrames(
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Frame> {
  const header = Buffer.alloc(4);
  let headerBytes = 0;
  let body: Buffer | undefined;
  let bodyBytes = 0;

  for await (const chunk of chunks) {
    let offset = 0;
    while (offset < chunk.length) {
      if (!body) {
        const count = Math.min(4 - headerBytes, chunk.length - offset);
        header.set(chunk.subarray(offset, offset + count), headerBytes);
        offset += count;
        headerBytes += count;
        if (headerBytes < 4) continue;
        const length = header.readUInt32BE();
        validateLength(length);
        body = Buffer.allocUnsafe(length);
      }

      const count = Math.min(body.length - bodyBytes, chunk.length - offset);
      body.set(chunk.subarray(offset, offset + count), bodyBytes);
      offset += count;
      bodyBytes += count;
      if (bodyBytes === body.length) {
        const kind = body.readUInt8();
        if (kind === 0) throw new Error("Invalid IPC frame kind 0");
        const frame = { kind, payload: body.subarray(1) };
        body = undefined;
        headerBytes = 0;
        bodyBytes = 0;
        yield frame;
      }
    }
  }
  if (headerBytes !== 0) throw new Error("Truncated IPC frame");
}
