# Changelog

## 0.1.21

- Open the command palette with Command+Space on macOS and Alt+Space on Linux and WSL when the terminal forwards the shortcut. See the README for terminal mappings.

## 0.1.20

- Open the SSH configuration editor from the new workspace chooser in the terminal work area.

## 0.1.19

- Open the workspace chooser below the sidebar list to reuse the current connection or choose a saved SSH alias.
- Edit the user OpenSSH configuration from the command palette.

## 0.1.18

- Resume remote tmux shells after SSH transport interruptions, including password reauthentication.
- Retry with a capped delay. Press Enter to retry sooner or Ctrl+C to stop.

## 0.1.17

- Share an authenticated OpenSSH connection across locally opened SSH tabs.
- Open the first shared SSH tab from the command palette.

## 0.1.16

- Open another SSH session to the same host when an older local agent still owns the original terminal.

## 0.1.15

- Show up to four terminal panes with a drop preview, click-to-focus, and draggable dividers.
- Hide panes without closing their running sessions.
- Open another session to the same foreground SSH destination and brighten default ANSI blue.
- Open supported local media and PDFs from the file explorer in the default application.

## 0.1.14

- Open the workspace rename dialog with the current name filled in.
- Open another SSH session to the same destination from the sidebar, even when the reported remote directory is unavailable.

## 0.1.13

- Restore the original terminal screen when the last session exits.
- Rename sessions from the sidebar using the pencil icon.
- Quit immediately from the command palette using the configured exit policy.

## 0.1.12

- Highlight the sidebar divider and show a horizontal resize pointer in compatible terminals while dragging.

## 0.1.11

- Added palette actions to move the sidebar between the left and right edges.
- Widened the clickable new-session and close buttons.
- Removed SSH connect, host switching, tmux management, and terminal history from the command palette.

## 0.1.10

- Added a close button to managed workspace rows with a confirmation dialog before stopping the session.

## 0.1.9

- Added a plus button to each workspace row that opens a new session from that row's current directory.
- Preserved the destination and reported working directory when opening another session from an SSH tab.

## 0.1.8

- Added sidebar controls to open a session in the selected context and toggle background pinning.
- Reused the SSH destination when opening a session from an interactive SSH tab.
- Started file browsing in the selected terminal's working directory on its host.

## 0.1.7

- Kept the command palette in a fixed position while filtering results.
- Made the footer and visible palette results clickable and guarded against stale clicks.
- Passed F12 through to the terminal application.

## 0.1.6

- Combined workspace actions and session switching in one command palette.
- Removed the Ctrl menu shortcut so control keys are delivered to the shell.

## 0.1.5

- Showed Option+Space on macOS and Alt+Space on Linux in the command palette shortcut hint.
- Made the sidebar resizable by dragging its divider and collapsible from the workspace menu.

## 0.1.4

- Offered to update, continue, or skip a release at startup.
- Kept the update in the menu when the user had already started interacting with the terminal.

## 0.1.3

- Added colored workspace tabs, sidebar actions, navigation hints, and a footer version badge.
- Added a searchable command palette accessible with Alt+Space or Space in the workspace menu.
- Added sidebar buttons for new workspaces and interactive OpenSSH tabs.
- Added an on-demand update check in the workspace menu and reopened the active session after updating.

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
