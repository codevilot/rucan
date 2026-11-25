# Development

Use a current Node 22 LTS patch, pnpm 10.32.1, and Rust stable with Rustfmt and Clippy. Bash, Zsh and Vim are required for the PTY probe. Run commands from the monorepo root.

| Command                          | Purpose                                   |
| -------------------------------- | ----------------------------------------- |
| `pnpm install --frozen-lockfile` | Install from the pnpm lockfile            |
| `pnpm dev`                       | Open the workspace in a TTY               |
| `pnpm build`                     | Compile the CLI and agent                 |
| `pnpm test`                      | Run Vitest and Rust tests                 |
| `pnpm lint`                      | Run ESLint, Rustfmt check and Clippy      |
| `pnpm typecheck`                 | Check CLI, tests and benchmark TypeScript |
| `pnpm format`                    | Format supported text files and Rust      |
| `pnpm benchmark`                 | Benchmark the native agent                |

Rust-only development uses `cargo build --locked`, `cargo test --locked` and `cargo clippy --locked --all-targets -- -D warnings`. The agent executable exposes version, socket service, detached startup, SSH bridging, and host-local session controls. See its usage output.

Set `XDG_CONFIG_HOME` to an absolute temporary directory to try first launch without changing your config. The CLI prints a filename and offending field on invalid configuration. Version 1 is the first format. Future migrations should validate old content, preserve user data and publish updates atomically.

If the pnpm shim is broken, run commands through `npm exec --yes --package=pnpm@10.32.1 -- pnpm`. If the interface does not fit, enlarge the terminal to at least 48 columns by 12 rows.

After `pnpm build`, try `pnpm dev new`, `pnpm dev ls`, and `pnpm dev pin <id>`. The local CLI starts the development agent when appropriate. Use `RUCAN_AGENT_SOCKET` with a private directory to isolate a test and `RUCAN_AGENT_BINARY` to choose a development binary. The per-user socket is under `XDG_RUNTIME_DIR/rucan` when configured or `/tmp/rucan-<uid>`. Use `pnpm dev --fixture` for the Ink layout fixture. After building, run `python3 tests/e2e/local_tty.py` for the live workspace and Vim smoke test.

Run `pnpm poc` for the original xterm.js reference probe. To validate isolated OpenSSH and tmux, build both remote Docker images and the agent artifact using [.github/workflows/ci.yml](../.github/workflows/ci.yml), then run the two `remote_ssh.py` modes. The tests generate disposable host and client keys.

The rename changes the default config, socket, cache and remote installation paths. If you used a pre-release build, copy any settings you want to keep from the old config into the new one. Keep the pre-release client available to reattach to its running sessions.
