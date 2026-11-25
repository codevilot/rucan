# Repository guidance

Use English for code, comments, documentation and CLI output. Keep application, configuration, input and presentation logic in TypeScript. Use strict compilation, explicit exported contracts, runtime validation at trust boundaries and discriminated unions for state and protocol operations. Avoid unsafe assertions and preserve existing caller behavior.

Use Rust for native PTY ownership, process lifecycle and asynchronous I/O. Keep unsafe code out of the application. Document ownership of child processes, tasks, sockets and queues. Use Rustfmt and run Clippy with warnings denied.

Keep React and Ink independent of the domain and protocol. Keep backend selection, persistence and connection location independent. Share contracts across languages via schemas and conformance fixtures. Favor small cohesive modules and review files beyond 300–400 lines.

Bound buffers, queues and frame sizes. Keep inactive workspaces out of the render loop. Measure CPU, memory and latency before claiming improvement. Exercise real PTYs and processes for terminal and lifecycle changes. Never pipe untrusted escape sequences to the outer terminal. Keep SSH host verification enabled, protect user-owned sockets, and keep terminal output and secrets out of diagnostic logs.

Update architecture, protocol, lifecycle and security documentation when a boundary changes. Mark fixture UI honestly and report what was tested with actual operating systems and applications. Preserve user changes. Each phase report includes limitations and remaining risks.

Run `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm exec prettier --check .` and relevant probes. Format with `pnpm format`. Use `pnpm benchmark` for the terminal probe and follow the performance methodology. Do not publish or release without explicit maintainer approval.
