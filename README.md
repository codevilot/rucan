# rucan

**All You Can.** Rucan brings local and SSH workspaces, file navigation, and persistent terminal sessions into one terminal-native workspace manager.

Open a shell and decide later whether to keep it running. The native agent owns each session from the start and keeps it alive across client disconnects. Native sessions require no tmux. Agents and host reboots end the lifetime of the running processes.

## Try the local workspace

The current build opens a native local shell, discovers running sessions, and supports pinning, switching, detaching and reattaching. The same interface opens SSH sessions and explores local or remote files. The optional tmux backend discovers existing sessions without taking ownership of them.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm dev
```

Type `exit` at the shell prompt to close the current shell. Open the command palette with Option+Space on macOS or Alt+Space on Linux. You can also click the palette shortcut in the footer. Search for **Close UI and keep sessions** to detach, or **Quit Rucan** to choose an exit policy. The first launch creates a sample at `~/.config/rucan/config.yaml` or under an absolute `XDG_CONFIG_HOME`.

```yaml
version: 1
workspaces:
  - name: local-shell
    cwd: "~"
    command: bash
  - name: gpu-server
    host: gpu-server
    cwd: "~/project"
    persistence: persistent
```

The numbered workspace list contains running sessions. When the selected session exits, Rucan opens the next running session. Use the sidebar or search the palette by workspace name or number to switch sessions.

Click **+** in the sidebar to open a new session in the selected workspace's environment. For an interactive SSH tab, it opens another connection to the same destination. Use **SSH connect** in the command palette to enter a new IP address, alias, or `user@host`. Click **BG** to pin or unpin the selected managed session.

Drag the sidebar divider to resize it. Search the palette for **Hide sidebar** or **Show sidebar**.

**Browse files** opens the selected session's current directory on its host. A plain SSH tab needs the remote shell to report its directory and a reachable agent on the destination.

Inside a managed shell, run `rucan` to see session commands. Use `npx rucan@latest` if you run Rucan through npm without a global installation.

`pnpm dev config` validates the configuration and prints its path. The npm package installs the `rucan` command. After the first release:

```sh
npm install -g rucan
rucan
```

Development targets macOS and Linux with Node 22 LTS and Rust stable. The initial implementation was validated on Apple Silicon. The release candidate targets AMD64 and ARM64 on both operating systems.

See the [architecture](docs/architecture.md) for the client, transport and agent diagram, [security](docs/security.md) for trust boundaries and [development](docs/development.md) for build and test commands. Contributions follow [CONTRIBUTING.md](CONTRIBUTING.md). RUCAN is licensed under [Apache-2.0](LICENSE).

## Known limits

- Native sessions survive client disconnects while their agent and host remain running. Host logout policies can stop detached agents.
- SSH opens with an already trusted host key and non-interactive authentication. Use OpenSSH first to approve a new host key.
- The current directory listing and preview limits are 500 entries and 64 KiB. Terminal viewports are bounded to 12,000 cells.
- Bash, Zsh, Vim and tmux have PTY coverage. Codex onboarding did not complete in the isolated PTY fixture. Codex, Claude Code and Neovim interoperability remains unverified.

See [remote setup](docs/remote.md), [distribution and release candidates](docs/distribution.md), and [measured performance](docs/performance.md). Local and remote sessions share the same Rust agent and protocol.
