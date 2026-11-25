# Security model

RUCAN loads user-owned YAML. The selected workspace configuration determines which executable and arguments start in a new PTY. File preview and editor actions use structured operations and a separate PTY. New configuration is created with mode 0600 in a user directory. Runtime validation rejects unknown settings, YAML aliases and invalid host aliases.

The threat model treats SSH hosts, filesystem names and PTY output as potentially hostile. The live client renders validated cells through one compositor. The agent responds to a limited set of terminal queries inside the child PTY. Clipboard, title and unsupported device control escapes do not reach the outer terminal. Live terminal state stays in memory.

Use OpenSSH host key verification, private same-user Unix sockets, no public listener and no credential storage. Socket paths and their parent directory require ownership and permission checks. Same-user processes and host administrators are outside the socket isolation guarantee. Installation requires explicit approval and an authenticated binary manifest. Never overwrite an active incompatible agent automatically.

The interactive SSH tab validates the destination and passes it to OpenSSH as a single argument after `--`. OpenSSH asks for confirmation for unknown host keys and handles authentication in the session PTY.

Session descriptions expose the destination of interactive OpenSSH tabs for reuse by the sidebar. Authentication stays inside OpenSSH.

See [SECURITY.md](../SECURITY.md) for reporting guidance.
