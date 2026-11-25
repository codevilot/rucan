# Protocol v1

Use a Unix stream locally and the same byte stream through an SSH stdio bridge. Each record starts with a four-byte unsigned big-endian length, including a one-byte frame kind but excluding the header. Kind 1 carries UTF-8 JSON control data. Reserve kinds 2 and higher for typed binary frames. Reject zero or over-limit lengths before allocating a body. Initial limit is 1 MiB per frame.

The opening hello advertises a version interval and capability set. A server replies with the highest mutually supported version, negotiated capabilities, and effective limits. Missing version overlap terminates the connection with an explicit error. The initial metadata contract is in [hello.schema.json](../packages/protocol/hello.schema.json). The Rust and TypeScript framing tests use shared conformance vectors. [Control request bindings](../packages/protocol/control.schema.json) are generated for both languages.

Subsequent requests need per-connection correlation IDs and typed errors. Planned operations include list, create, attach, detach, rename, pin, terminate, resize, and paginated filesystem reads with cancellable request IDs. Session IDs are opaque and unique within an agent lifetime. Attachments use connection-scoped identifiers.

Attach delivers a snapshot at sequence N followed by changes after N. Validate terminal dimensions and stream IDs before handling binary input. Input and resize require the current attachment lease. Slow clients with full queues should be disconnected or resynchronized from the latest bounded snapshot. PTY reads must continue independently. The visible grid is bounded and uses the span and patch representation below.

Additionally reject hello messages whose minimum exceeds their maximum. This cross-field rule is verified by negotiation logic.

Kind 0 is invalid. The shared [framing vectors](../packages/protocol/framing-vectors.txt) cover an empty payload, control payload, and binary data containing NUL and bytes outside UTF-8.

## Native session operations

After hello, exchange one request and response at a time on each connection. A JSON request is an object with numeric unsigned 32-bit `id` and an `operation` object tagged with `type`. Responses echo the ID and include either `ok: true` and `value`, or `ok: false` and `error`.

The native agent supports `list`, `create`, `attach`, `detach`, `pin`, `kill`, `resize`, `snapshot` and `watch`. Session operations identify a UUID in the `session` field. Create takes `name`, `command`, `args`, `cwd`, `rows`, `cols` and `persistent`. Pin sets the `persistent` flag. Resize takes `rows` and `cols`.

Input kind 2 carries a four-byte unsigned big-endian request ID, 16 UUID bytes in standard network order, and up to 8192 input bytes. Resize and input are accepted only from the controlling connection. Attaching grants control if no controller is present, otherwise it returns observer status. Closing a connection releases its input leases.

A snapshot contains plain display text, active buffer, cursor, child state and sequence. `watch` accepts an `after` sequence and returns the newest snapshot when it changes, or null after an idle timeout of 25 seconds. Use a dedicated watching connection for concurrent input. The sequence channel coalesces pending updates and PTY readers proceed regardless of watcher speed. This initial wire representation carries full visible snapshots. Styled cells and incremental display updates are phase gates for the interactive UI.

Styled snapshots include a `grid` of visible `lines`. Each line carries spans as `[width, text, [flags, fg, bg]]`. Flags from least significant bit are bold, dim, italic, underline and inverse. Color -1 is default, 0–255 is indexed, and 256 plus packed RGB is true color. Trailing default blanks may be omitted. Limit viewports to 500 columns, 200 rows and 12,000 cells.

On a continuing watch, when the same connection sends the exact previous sequence and the grid geometry is unchanged, the reply includes top-level `baseSequence` and `grid.patch` containing `[rowIndex, spans]` entries in place of `grid.lines`. The sequence, cursor, and modes are carried in both replies. After a mismatch or resize the agent sends a full grid.

An explicit cross-client detach has `force: true`; normal workspace switching releases only the caller's lease. Shutdown accepts `force` and refuses to stop with active native sessions unless it is true. Scrollback, rename, filesystem and tmux operations share the [request schema](../packages/protocol/control.schema.json).

Session descriptions may include `sshTarget` for an interactive OpenSSH tab. Compatible clients accept an absent field from older agents. The agent reports the destination only for the specific invocation used by the SSH tab.
