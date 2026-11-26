# Security model

RUCAN loads user-owned YAML. The selected workspace configuration determines which executable and arguments start in a new PTY. File preview and editor actions use structured operations and a separate PTY. New configuration is created with mode 0600 in a user directory. Runtime validation rejects unknown settings, YAML aliases and invalid host aliases.

The file explorer can open supported local media and PDFs with the desktop's default application after explicit user input. It checks that the path resolves to a regular, non-executable file and passes it as a single argument to the desktop opener. Remote explorer paths and terminal output cannot trigger this action.

The threat model treats SSH hosts, filesystem names and PTY output as potentially hostile. The live client renders validated cells through one compositor. The agent responds to a limited set of terminal queries inside the child PTY. Clipboard, title and unsupported device control escapes do not reach the outer terminal. Live terminal state stays in memory.

Use OpenSSH host key verification, private same-user Unix sockets, no public listener and no credential storage. Socket paths and their parent directory require ownership and permission checks. Same-user processes and host administrators are outside the socket isolation guarantee. Installation requires explicit approval and an authenticated binary manifest. Never overwrite an active incompatible agent automatically.

The interactive SSH tab validates the destination and passes it to OpenSSH as a single argument after `--`. OpenSSH asks for confirmation for unknown host keys and handles authentication in the session PTY.

Session descriptions expose the destination of interactive OpenSSH tabs for reuse by the sidebar. Authentication stays inside OpenSSH.

See [SECURITY.md](../SECURITY.md) for reporting guidance.

Working-directory lookups use the selected PTY child and never send commands into the foreground terminal. OSC 7 reports are treated as untrusted paths. They can select a folder on the already selected SSH destination and are never rendered as control sequences.

When an SSH tab reports a directory, a new connection uses a quoted path in a fixed remote shell command. Host-key verification and authentication remain with OpenSSH.

To open another SSH workspace, the agent may inspect the bounded arguments of the PTY foreground process. It returns only a destination or an unsupported indicator. The CLI opens the destination with its own SSH invocation and host-key verification, without replaying the foreground command or its options.

With an older local agent, the CLI can check the user-owned PTY foreground group directly when creating a new session. Remote agent PIDs are excluded from local inspection, and only a validated SSH destination crosses into a new invocation.
