# ADR 0001: Agent-owned terminal state, composed client display

Status: proposed for Phase 2 and Phase 3.

Raw PTY bytes can move the outer cursor, change terminal modes, or request clipboard actions. The client will compose a trusted screen from cells and attributes and emit only its own display sequences. One writer owns layout, terminal cells, cursor and outer modes. Batch changes and evaluate row-level diffs before implementing finer-grained updates.

Ink is the fixture and workspace interface. Its text layout and reconciliation are a poor interface for one update per PTY chunk, and cursor and alternate buffer behavior need a dedicated boundary. Evaluate rendering the Ink chrome off-screen as input to the compositor. If this adds cost or blocks cursor fidelity, use a TypeScript cell compositor for the interactive view.

The MIT-licensed xterm.js headless parser is the TypeScript reference for experiments. It requires Node.js, so it cannot own persistent remote state under the deployment constraints. A Rust parser such as MIT-licensed vt100 is a candidate. Compare cell attributes, wide glyphs, alternate buffers, mode reporting, terminal replies, scrollback and snapshot recovery before choosing. Measure throughput and memory on both Linux and macOS. Portable PTY 0.9 (MIT) is exercised by the probe. Tokio (MIT) is a candidate for asynchronous agent I/O after transport work begins.

The reference probe exercises observable PTY output and the xterm.js cell model. It does not measure presentation performance or establish feature parity between emulators.

## Findings

Bash and Zsh output reached the reference grid and Vim entered and exited the alternate buffer. A separate projection test preserved wide-cell positions, the cursor and RGB foreground attributes while excluding an OSC clipboard sequence from displayed cell text.

Codex CLI 0.172.0 launched under a disposable PTY and emitted terminal capability and color queries. The limited reply experiment did not reach onboarding. Implement and verify terminal query handling alongside input routing before claiming Codex compatibility. Tmux was unavailable on the test machine.

## Local interactive implementation

The local workspace uses a TypeScript compositor as the sole stdout writer. It compares composed rows, owns cursor positioning and restores terminal modes on exit. React and Ink remain available through the fixture command. The Rust vt100 parser owns cells, modes and scrollback. It replies to supported terminal queries on the child PTY without exposing raw escape requests to the outer terminal. Cell spans carry width, colors and attributes. Watches send changed rows against a known sequence and reset to a full viewport after a resize or subscription restart.
