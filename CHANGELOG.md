# Changelog

## 0.1.1

- Made workspace navigation and exit actions easier to find.
- Displayed the running CLI version in the workspace header.
- Repainted the workspace when the terminal size changes.
- Checked that the npm archive includes all four native agents and starts the matching bundled agent.

## 0.1.0

- Renamed the project, npm package, and CLI to Rucan. The native agent is `rucan-agent`.

- Added a strict YAML config loader and a labeled workspace fixture.
- Added a native PTY probe and a reference terminal parser experiment.
- Documented proposed protocol, session lifecycle and rendering boundaries.
- Added local native PTY sessions with same-user socket discovery, input leases, persistence metadata and bounded snapshot watching.
- Added the interactive local workspace with a single terminal compositor, row patches, focus routing and exit policies.
- Added OpenSSH deployment and reconnect, with verified offline transfer.
- Added lazy filesystem browsing, safe previews and separate editor sessions.
- Added optional tmux discovery and attachment with external session protection.
- Added multi-platform release candidate packaging and user-approved update flows.
