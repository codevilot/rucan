import { once } from "node:events";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import {
  decodeFrames,
  encodeFrame,
  maxFrameBytes,
  type Frame,
} from "./framing.js";

import type { Operation } from "./operation.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class SessionClient {
  readonly #socket: Duplex;
  readonly #incoming: AsyncGenerator<Frame>;
  #requestId = 0;
  #pending = false;
  #workspaceCwd = false;

  private constructor(socket: Duplex) {
    this.#socket = socket;
    this.#incoming = decodeFrames(socket);
    socket.on("error", () => {
      // The async iterator reports stream errors to the pending exchange.
    });
  }

  static async connect(path: string): Promise<SessionClient> {
    const socket = createConnection(path);
    try {
      await once(socket, "connect", { signal: AbortSignal.timeout(5000) });
      return await SessionClient.negotiate(socket);
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }

  static async negotiate(
    stream: Duplex,
    deadline = 5000,
  ): Promise<SessionClient> {
    const client = new SessionClient(stream);
    try {
      const reply = await client.#exchange(
        1,
        Buffer.from(
          JSON.stringify({
            type: "hello",
            minVersion: 1,
            maxVersion: 1,
            capabilities: ["native-session", "workspace-cwd"],
          }),
        ),
        deadline,
      );
      if (reply.type === "error" && reply.code === "incompatible-version") {
        throw new Error("Agent protocol is incompatible with this client");
      }
      if (
        reply.type !== "welcome" ||
        reply.version !== 1 ||
        typeof reply.maxFrameBytes !== "number" ||
        reply.maxFrameBytes !== maxFrameBytes ||
        !Array.isArray(reply.capabilities) ||
        !reply.capabilities.includes("native-session")
      ) {
        throw new Error("Invalid agent negotiation response");
      }
      client.#workspaceCwd = reply.capabilities.includes("workspace-cwd");
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  async #exchange(
    kind: number,
    bytes: Uint8Array,
    deadline = 5000,
  ): Promise<Record<string, unknown>> {
    if (this.#pending)
      throw new Error("An agent request is already in progress");
    this.#pending = true;
    const expires = setTimeout(
      () => this.#socket.destroy(new Error("Agent request timed out")),
      deadline,
    );
    try {
      const frame = encodeFrame(kind, bytes);
      await new Promise<void>((resolve, reject) => {
        this.#socket.write(frame, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      const reply = await this.#incoming.next();
      if (reply.done || reply.value.kind !== 1)
        throw new Error("Missing agent control response");
      const data: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(reply.value.payload),
      );
      if (!isRecord(data)) throw new Error("Invalid agent control response");
      return data;
    } catch (error) {
      this.close();
      throw error;
    } finally {
      clearTimeout(expires);
      this.#pending = false;
    }
  }

  async #request(
    id: number,
    kind: number,
    payload: Buffer,
    deadline?: number,
  ): Promise<unknown> {
    const reply = await this.#exchange(kind, payload, deadline);
    if (reply.id !== id || typeof reply.ok !== "boolean") {
      this.close();
      throw new Error("Agent response does not match the request");
    }
    if (!reply.ok)
      throw new Error(
        typeof reply.error === "string"
          ? reply.error
          : "Invalid agent error response",
      );
    return reply.value;
  }

  async request(operation: Operation): Promise<unknown> {
    const id = (this.#requestId = (this.#requestId + 1) >>> 0);
    return this.#request(
      id,
      1,
      Buffer.from(JSON.stringify({ id, operation })),
      operation.type === "watch" ? 30_000 : undefined,
    );
  }

  async sendInput(session: string, input: Uint8Array): Promise<void> {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(session)) {
      throw new Error("Invalid session ID");
    }
    if (input.length > 8192) throw new Error("Input chunk exceeds 8192 bytes");
    const id = (this.#requestId = (this.#requestId + 1) >>> 0);
    const payload = Buffer.allocUnsafe(20 + input.length);
    payload.writeUInt32BE(id);
    payload.set(Buffer.from(session.replaceAll("-", ""), "hex"), 4);
    payload.set(input, 20);
    await this.#request(id, 2, payload);
  }

  get closed(): boolean {
    return this.#socket.destroyed;
  }

  get supportsWorkspaceCwd(): boolean {
    return this.#workspaceCwd;
  }

  close(): void {
    this.#socket.destroy();
  }
}
