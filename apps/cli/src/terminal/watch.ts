import { setTimeout as delay } from "node:timers/promises";
import type { SessionClient } from "../protocol/client.js";
import { decodeSnapshot, type TerminalSnapshot } from "./snapshot.js";

export class TerminalWatch {
  #generation = 0;
  #connection: SessionClient | undefined;
  #connect: () => Promise<SessionClient>;

  constructor(connect: () => Promise<SessionClient>) {
    this.#connect = connect;
  }

  stop(): void {
    this.#generation++;
    this.#connection?.close();
    this.#connection = undefined;
  }

  start(
    id: string,
    initial: TerminalSnapshot,
    onSnapshot: (snapshot: TerminalSnapshot) => void,
    onError: (error: unknown) => void,
  ): void {
    this.stop();
    const generation = this.#generation;
    const active = (): boolean => this.#generation === generation;
    void (async () => {
      let snapshot = initial;
      let wait = 0;
      while (active()) {
        if (wait) await delay(wait);
        if (!active()) return;
        let connection: SessionClient | undefined;
        try {
          connection = await this.#connect();
          if (!active()) return;
          this.#connection = connection;
          if (wait) {
            const full = await connection.request({
              type: "snapshot",
              session: id,
            });
            if (!active()) return;
            snapshot = decodeSnapshot(full);
            onSnapshot(snapshot);
          }
          while (active()) {
            const raw = await connection.request({
              type: "watch",
              session: id,
              after: snapshot.sequence,
            });
            wait = 0;
            if (raw === null || !active()) continue;
            snapshot = decodeSnapshot(raw, snapshot);
            onSnapshot(snapshot);
          }
          return;
        } catch (error) {
          if (!active()) return;
          onError(error);
          wait = Math.min(wait ? wait * 2 : 1000, 15000);
        } finally {
          connection?.close();
        }
      }
    })();
  }
}
