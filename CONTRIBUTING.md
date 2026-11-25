# Contributing

Read the [development guide](docs/development.md) and [repository conventions](AGENTS.md). Describe the behavior change and include validation results in your pull request. Include a reproducible PTY or transport case for changes to those boundaries. Discuss changes to protocol and process ownership before implementation.

Contributions submitted for inclusion follow the project’s [Apache-2.0 license](LICENSE).

## Branches and pull requests

Branch from current `main` and keep each pull request focused on one change.
Use short, descriptive branch names such as `fix/socket-cleanup`. Write commit
subjects as `type: summary`, using types such as `feat`, `fix`, `docs`,
`test`, or `chore`.

Open pull requests against `main`, record the checks you ran, and wait for CI
before merging. Prefer squash merges with the pull request title as the final
commit subject. Keep native dependency upgrades in focused pull requests so
their PTY and transport checks are easy to review. GitHub Actions updates are
grouped by Dependabot.
