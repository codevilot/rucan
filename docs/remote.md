# Remote workspaces

To create a managed OpenSSH tab from the CLI, run `rucan new ssh -o StrictHostKeyChecking=ask -- user@host` and select the new session in Rucan. You can use an IP address or an SSH alias as the destination. The agent that owns the session runs OpenSSH with its host’s SSH configuration and credentials. The tab supports OpenSSH's host-key confirmation and authentication prompts. It stays available while the underlying SSH connection is alive. Click **+** on the SSH tab's row to open another connection to the same destination. If the tab has reported a working directory through OSC 7, the new shell starts there.

## Agent-backed remote workspaces

Use a host alias from your OpenSSH configuration. Establish trust with OpenSSH before opening the workspace. RUCAN uses non-interactive SSH with the user's existing alias, keys, ProxyJump, agent and host verification policy.

```sh
rucan remote inspect gpu-server
rucan remote install gpu-server
rucan remote open gpu-server
rucan ls --host gpu-server
rucan attach gpu-server:<session-id>
```

The install command selects a matching packaged artifact. In a development checkout, supply the binary and a SHA-256 obtained independently from the artifact:

```sh
rucan remote install gpu-server ./rucan-agent-linux-arm64 <trusted-sha256>
```

The remote daemon is detached with `setsid`, with standard streams redirected. A separate OpenSSH stdio bridge connects to its private Unix socket. The target needs a Unix shell and common command-line utilities. It can receive the binary without a remote internet connection and runs without Node.js, npm, Rust or tmux.

Remote platform checks report OS, architecture and libc or macOS version. On a systemd host, the reported linger field is a clue about logout policy. Some installations terminate all processes in an SSH user scope even after the child detaches. Test this with a disposable session on the intended host. RUCAN does not enable lingering or change machine policy.

Agents preserve temporary and pinned native sessions when SSH drops. Pinning controls the explicit exit policy in the workspace. Host reboot or agent shutdown ends the ownership of native PTYs. tmux sessions are owned by the tmux server and are kept separate from RUCAN's lifecycle.

The isolated SSH test uses a networkless Linux container and connects through OpenSSH ProxyCommand to its loopback listener. Separate SSH identities exercise reconnect after the first client process group is killed.

## File browsing

The command palette starts browsing in the selected workspace's current directory on the workspace agent. Older agents fall back to the workspace's starting directory. For a managed tab opened through **SSH connect** or an SSH alias in **New workspace**, Rucan initializes working-directory reporting. Bash reports the directory after each change when the next prompt appears. Other shells report the starting directory and can provide live updates through their own OSC 7 prompt integration. Reopen an already running tab to load the new setup. Manually launched and resumable SSH sessions rely on the remote shell or tmux to forward OSC 7. File browsing also requires a reachable Rucan agent with non-interactive OpenSSH authentication. Browse and preview requests go to that destination. Direct SSH tabs opened from a remote agent can use an agent-backed workspace on the final destination for file access.
