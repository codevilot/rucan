import type { SessionClient } from "../protocol/client.js";
import { paneSize, type Pane } from "./panes.js";
import { decodeSnapshot, type TerminalSnapshot } from "./snapshot.js";
import { TerminalWatch } from "./watch.js";

interface Attachment {
  watch: TerminalWatch;
  controls: boolean;
  size?: string;
  snapshot: TerminalSnapshot;
}

/** Own watch connections and resize leases for visible, unfocused panes. */
export class PaneWatches {
  #attachments = new Map<string, Attachment>();

  constructor(private readonly connect: () => Promise<SessionClient>) {}

  snapshot(id: string): TerminalSnapshot | undefined {
    return this.#attachments.get(id)?.snapshot;
  }

  stop(): void {
    for (const { watch } of this.#attachments.values()) watch.stop();
    this.#attachments.clear();
  }

  async sync(
    client: SessionClient,
    panes: Pane[],
    selected: string | undefined,
    hasLease: (reply: unknown) => boolean,
    changed: (id: string, snapshot: TerminalSnapshot) => void,
    failed: (error: unknown) => void,
  ): Promise<void> {
    const visible = new Set(panes.map(({ id }) => id));
    for (const [id, attachment] of this.#attachments) {
      if (id !== selected && visible.has(id)) continue;
      attachment.watch.stop();
      this.#attachments.delete(id);
      if (id !== selected && attachment.controls)
        await client.request({ type: "detach", session: id });
    }
    for (const pane of panes) {
      const id = pane.id;
      if (id === selected) continue;
      let attachment = this.#attachments.get(id);
      if (!attachment) {
        const controls = hasLease(
          await client.request({ type: "attach", session: id }),
        );
        const snapshot = decodeSnapshot(
          await client.request({ type: "snapshot", session: id }),
        );
        const watch = new TerminalWatch(this.connect);
        attachment = { controls, watch, snapshot };
        this.#attachments.set(id, attachment);
        const current = attachment;
        if (snapshot.state !== "running") {
          changed(id, snapshot);
          continue;
        }
        watch.start(
          id,
          snapshot,
          (next) => {
            current.snapshot = next;
            changed(id, next);
          },
          failed,
        );
      }
      if (!attachment.controls || attachment.snapshot.state !== "running")
        continue;
      const { rows, cols } = paneSize(pane);
      const size = `${rows}:${cols}`;
      if (attachment.size === size) continue;
      await client.request({ type: "resize", session: id, rows, cols });
      attachment.size = size;
    }
  }
}
