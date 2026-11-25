# Distribution and release candidates

The release-candidate workflow builds native binaries for Linux AMD64 and ARM64 using static musl builds, and for macOS AMD64 and ARM64 with a macOS 12 deployment target. It stages a version-matched npm tarball containing the four agents, their SHA-256 manifest, and the CLI. The workflow attests the resulting artifacts and uploads them to the workflow run. It does not create a GitHub Release or publish to npm.

Maintainers can verify a candidate's provenance against this repository, run the smoke tests on each target, and review dependency notices and the package name before approving a release. npm should use trusted publishing or provenance. A GitHub Release should carry the attested individual agent binaries and manifest. The release manifest inside the npm tarball is part of the authenticated npm artifact. SSUI verifies its digest before starting a bundled local binary and before transferring and installing a remote binary. Development binaries explicitly supplied with `SSUI_AGENT_BINARY` are trusted by the caller.

Packaged clients can run `ssui remote install <alias>` and transfer the matching bundled binary to a host without internet access. Development builds can pass a trusted binary and SHA-256 explicitly. This command is the user's installation approval. The remote shell verifies the hash again, runs a version probe, and links the fully written executable into place. Different existing artifacts are left in place. An incompatible running agent must be stopped explicitly before replacing it. Compatible CLI updates reuse an existing agent and socket.

The startup update check is asynchronous and caches the stable registry response. The user can disable it in configuration, skip a version, or use `ssui update --apply` to approve a detected global npm or pnpm update. The updater delegates package installation to the detected manager and does not request elevated privileges.

## Maintainer CLI

From the repository root with GitHub CLI authenticated and the latest public
`main` commit checked out, prepare and inspect an attested candidate:

```sh
npm run release:prepare
npm run release:publish -- --dry-run
```

Preparation reuses a successful candidate for the current commit or starts and
watches the four-platform workflow. It stores the verified archive under
`target/npm-release/<commit>/`.

To publish the candidate after review:

```sh
npm login --registry=https://registry.npmjs.org/
npm run release:publish
```
