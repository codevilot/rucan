# Remote workspaces

Use a host alias from your OpenSSH configuration. Establish trust with OpenSSH before opening the workspace. SSUX uses non-interactive SSH with the user's existing alias, keys, ProxyJump, agent and host verification policy.

```sh
ssux remote inspect gpu-server
ssux remote install gpu-server
ssux remote open gpu-server
ssux ls --host gpu-server
ssux attach gpu-server:<session-id>
```

The install command selects a matching packaged artifact. In a development checkout, supply the binary and a SHA-256 obtained independently from the artifact:

```sh
ssux remote install gpu-server ./ssux-agent-linux-arm64 <trusted-sha256>
```

The remote daemon is detached with `setsid`, with standard streams redirected. A separate OpenSSH stdio bridge connects to its private Unix socket. The target needs a Unix shell and common command-line utilities. It can receive the binary without a remote internet connection and runs without Node.js, npm, Rust or tmux.

Remote platform checks report OS, architecture and libc or macOS version. On a systemd host, the reported linger field is a clue about logout policy. Some installations terminate all processes in an SSH user scope even after the child detaches. Test this with a disposable session on the intended host. SSUX does not enable lingering or change machine policy.

Agents preserve temporary and pinned native sessions when SSH drops. Pinning controls the explicit exit policy in the workspace. Host reboot or agent shutdown ends the ownership of native PTYs. tmux sessions are owned by the tmux server and are kept separate from SSUX's lifecycle.

The isolated SSH test uses a networkless Linux container and connects through OpenSSH ProxyCommand to its loopback listener. Separate SSH identities exercise reconnect after the first client process group is killed.
