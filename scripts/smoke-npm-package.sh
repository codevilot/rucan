#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1" ]]; then
  echo "Usage: bash scripts/smoke-npm-package.sh <npm-tarball>" >&2
  exit 1
fi

tarball=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
scratch=$(mktemp -d /tmp/rucan-package.XXXXXX)
export RUCAN_AGENT_SOCKET="$scratch/agent.sock"
export XDG_CONFIG_HOME="$scratch/config"
export npm_config_cache="$scratch/npm-cache"
unset RUCAN_AGENT_BINARY

run_rucan() {
  npm exec --yes --ignore-scripts --package="$tarball" -- rucan "$@"
}

cleanup() {
  if [[ -S "$RUCAN_AGENT_SOCKET" ]]; then
    run_rucan shutdown || true
  fi
  rm -rf -- "$scratch"
}
trap cleanup EXIT

cd "$scratch"
tar -tzf "$tarball" > package-files.txt
for platform in linux-x64 linux-arm64 darwin-x64 darwin-arm64; do
  grep -Fx "package/agents/$platform/rucan-agent" package-files.txt
done
grep -Fx "package/agents/manifest.json" package-files.txt
run_rucan --version
run_rucan ls
run_rucan shutdown
