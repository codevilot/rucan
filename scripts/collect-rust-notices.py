"""Collect license notices for dependencies linked into the four agent builds."""
import json
from pathlib import Path
import re
import subprocess
import sys

TARGETS = (
    "x86_64-unknown-linux-musl",
    "aarch64-unknown-linux-musl",
    "x86_64-apple-darwin",
    "aarch64-apple-darwin",
)

packages = {}
for target in TARGETS:
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--locked", "--format-version", "1", "--filter-platform", target],
        text=True,
    ))
    dependencies = {node["id"]: node["deps"] for node in metadata["resolve"]["nodes"]}
    known = {entry["id"]: entry for entry in metadata["packages"]}
    pending = list(metadata["workspace_members"])
    selected = set(pending)
    while pending:
        package = pending.pop()
        for edge in dependencies[package]:
            if edge["pkg"] not in selected and any(data["kind"] is None for data in edge["dep_kinds"]):
                pending.append(edge["pkg"])
                selected.add(edge["pkg"])
    for item in selected.difference(metadata["workspace_members"]):
        package = known[item]
        packages[package["name"], package["version"]] = package

out = Path(sys.argv[1])
with out.open("w", encoding="utf-8") as notices:
    notices.write("Third-party notices for rucan-agent\n")
    for (name, version), package in sorted(packages.items()):
        directory = Path(package["manifest_path"]).parent
        files = sorted(
            item for item in directory.iterdir()
            if item.is_file() and re.match(r"^(licen[cs]e|copying|copyright|notice)($|[._-])", item.name, re.I)
        )
        if package["license_file"]:
            declared = directory / package["license_file"]
            if declared not in files:
                files.append(declared)
        if not files:
            raise RuntimeError(f"No distributed license text for {name} {version}")
        notices.write(f"\n{'=' * 72}\n{name} {version} ({package['license'] or 'see included text'})\n")
        for path in files:
            notices.write(f"\n{path.name}\n{path.read_text(encoding='utf-8')}\n")
