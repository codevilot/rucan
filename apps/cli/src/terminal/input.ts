const pasteStart = Buffer.from("\x1b[200~");
const pasteEnd = Buffer.from("\x1b[201~");
const mouseStart = Buffer.from("\x1b[<");
const f12 = Buffer.from("\x1b[24~");

export interface MouseEvent {
  button: number;
  col: number;
  row: number;
  release: boolean;
}

export type TerminalInput =
  | { type: "bytes"; bytes: Buffer }
  | { type: "palette" }
  | { type: "paste-start" | "paste-end" }
  | ({ type: "mouse" } & MouseEvent);

function mouseReport(
  bytes: Buffer,
): { event: MouseEvent; length: number } | "incomplete" | undefined {
  const prefix = bytes.subarray(0, mouseStart.length);
  if (!mouseStart.subarray(0, prefix.length).equals(prefix)) return undefined;
  const text = bytes.subarray(0, 32).toString("latin1");
  const match = /^\x1b\[<(\d{1,3});(\d{1,5});(\d{1,5})([Mm])/u.exec(text);
  if (match) {
    const [, button, col, row, action] = match;
    return {
      event: {
        button: Number(button),
        col: Number(col),
        row: Number(row),
        release: action === "m",
      },
      length: match[0].length,
    };
  }
  return bytes.length < 32 && /^(?:\x1b|\x1b\[|\x1b\[<[\d;]*)$/u.test(text)
    ? "incomplete"
    : undefined;
}

/** Recognize palette shortcuts, bracketed paste, and the outer terminal's SGR mouse reports. */
export class InputRouter {
  #paste = false;
  #tail = Buffer.alloc(0);

  get hasPending(): boolean {
    return this.#tail.length > 0;
  }

  takePending(): Buffer {
    const result = this.#tail;
    this.#tail = Buffer.alloc(0);
    return result;
  }

  *route(chunk: Buffer): Generator<TerminalInput> {
    const tail = this.takePending();
    const input = tail.length > 0 ? Buffer.concat([tail, chunk]) : chunk;
    let start = 0;
    for (let index = 0; index < input.length; index++) {
      const byte = input[index];
      let event: TerminalInput | undefined;
      let length = 1;
      let incomplete = false;
      if (byte === 0x1b && input[index + 1] === 0x20 && !this.#paste) {
        event = { type: "palette" };
        length = 2;
      } else if (byte === 0x1b) {
        const remainder = input.subarray(index);
        const marker = this.#paste ? pasteEnd : pasteStart;
        const candidate = remainder.subarray(0, marker.length);
        if (marker.subarray(0, candidate.length).equals(candidate)) {
          if (candidate.length < marker.length) {
            incomplete = true;
          } else {
            this.#paste = !this.#paste;
            event = { type: this.#paste ? "paste-start" : "paste-end" };
            length = marker.length;
          }
        } else if (!this.#paste) {
          const key = remainder.subarray(0, f12.length);
          if (f12.subarray(0, key.length).equals(key)) {
            incomplete = key.length < f12.length;
            if (!incomplete) {
              event = { type: "palette" };
              length = f12.length;
            }
          } else {
            const mouse = mouseReport(remainder);
            if (mouse === "incomplete") incomplete = true;
            else if (mouse) {
              event = { type: "mouse", ...mouse.event };
              length = mouse.length;
            }
          }
        }
      }
      if (!event && !incomplete) continue;
      if (index > start)
        yield { type: "bytes", bytes: input.subarray(start, index) };
      if (incomplete) {
        this.#tail = Buffer.from(input.subarray(index));
        return;
      }
      if (event) yield event;
      index += length - 1;
      start = index + 1;
    }
    if (start < input.length)
      yield { type: "bytes", bytes: input.subarray(start) };
  }
}
