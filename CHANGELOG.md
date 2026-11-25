# Changelog

## 0.1.3

- Added colored workspace tabs, sidebar actions, navigation hints, and a footer version badge.
- Added a searchable command palette accessible with Alt+Space or Space in the workspace menu.
- Added sidebar buttons for new workspaces and interactive OpenSSH tabs.

## 0.1.2

- Removed exited sessions from the numbered workspace list and switched to the next running workspace.
- Added F12 as an alternative menu shortcut and clarified how to quit the shell or the UI.
- Showed session commands when invoking Rucan from a managed shell without arguments.

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
