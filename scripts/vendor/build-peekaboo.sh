#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
peekaboo_root_input="${1:-${PEEKABOO_REPO:-"$repo_root/../Peekaboo-serbyte"}}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "The vendored Universal 2 Peekaboo binaries must be built on macOS." >&2
  exit 1
fi

for required_command in codesign git lipo node shasum strings strip swift; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command not found: $required_command" >&2
    exit 1
  fi
done

if [[ ! -d "$peekaboo_root_input" ]]; then
  echo "Peekaboo repository not found: $peekaboo_root_input" >&2
  echo "Usage: $0 /absolute/path/to/Peekaboo" >&2
  exit 1
fi

peekaboo_root="$(cd -- "$peekaboo_root_input" && pwd -P)"
if [[ ! -f "$peekaboo_root/Apps/CLI/Package.swift" || ! -f "$peekaboo_root/LICENSE" ]]; then
  echo "Not a Peekaboo checkout: $peekaboo_root" >&2
  exit 1
fi

source_commit="$(git -C "$peekaboo_root" rev-parse HEAD)"
source_repository="$(git -C "$peekaboo_root" remote get-url origin 2>/dev/null || printf 'unknown')"
source_version="$(git -C "$peekaboo_root" describe --tags --always "$source_commit" 2>/dev/null || printf '%s' "$source_commit")"
target_triples=("arm64-apple-macosx" "x86_64-apple-macosx")
binary_names=("peekaboo" "peekaboo-cursor-host")
temporary_root="$(mktemp -d "${TMPDIR:-/tmp}/shellby-peekaboo.XXXXXX")"
source_worktree="$temporary_root/peekaboo"
vendor_dir="$repo_root/vendor/peekaboo"
worktree_added=false

cleanup() {
  if [[ "$worktree_added" == true ]]; then
    git -C "$peekaboo_root" worktree remove --force "$source_worktree" >/dev/null 2>&1 || true
  fi
  rm -rf "$temporary_root"
}
trap cleanup EXIT

git -C "$peekaboo_root" worktree add --detach "$source_worktree" "$source_commit"
worktree_added=true

for target_triple in "${target_triples[@]}"; do
  scratch_path="$temporary_root/build-$target_triple"
  swift build \
    --package-path "$source_worktree/Apps/CLI" \
    --configuration release \
    --triple "$target_triple" \
    --scratch-path "$scratch_path"
  bin_path="$(swift build \
    --package-path "$source_worktree/Apps/CLI" \
    --configuration release \
    --triple "$target_triple" \
    --scratch-path "$scratch_path" \
    --show-bin-path)"

  for binary_name in "${binary_names[@]}"; do
    built_binary="$bin_path/$binary_name"
    if [[ ! -x "$built_binary" ]]; then
      echo "Build completed without an executable at $built_binary" >&2
      exit 1
    fi
    cp "$built_binary" "$temporary_root/$binary_name.$target_triple"
    strip -x "$temporary_root/$binary_name.$target_triple"
  done
done

mkdir -p "$vendor_dir"
for binary_name in "${binary_names[@]}"; do
  output="$temporary_root/$binary_name"
  lipo -create \
    "$temporary_root/$binary_name.arm64-apple-macosx" \
    "$temporary_root/$binary_name.x86_64-apple-macosx" \
    -output "$output"
  chmod 0755 "$output"
  codesign --force --sign - "$output"

  architectures="$(lipo -archs "$output")"
  if [[ "$architectures" != *"arm64"* || "$architectures" != *"x86_64"* ]]; then
    echo "$binary_name is missing a required architecture: $architectures" >&2
    exit 1
  fi
  if strings "$output" | grep -Eq '/Users/[^/]+/'; then
    echo "$binary_name still contains a macOS user-home path after stripping." >&2
    exit 1
  fi
  codesign --verify "$output"
done

peekaboo_sha256="$(shasum -a 256 "$temporary_root/peekaboo" | awk '{print $1}')"
peekaboo_size="$(stat -f '%z' "$temporary_root/peekaboo")"
cursor_sha256="$(shasum -a 256 "$temporary_root/peekaboo-cursor-host" | awk '{print $1}')"
cursor_size="$(stat -f '%z' "$temporary_root/peekaboo-cursor-host")"
swift_version="$(swift --version | head -1)"

node - \
  "$temporary_root/provenance.json" \
  "$source_repository" \
  "$source_commit" \
  "$source_version" \
  "$peekaboo_sha256" \
  "$peekaboo_size" \
  "$cursor_sha256" \
  "$cursor_size" \
  "$swift_version" <<'NODE'
const fs = require("node:fs")

const [
  output,
  sourceRepository,
  sourceCommit,
  sourceVersion,
  peekabooSha256,
  peekabooSize,
  cursorSha256,
  cursorSize,
  swift,
] = process.argv.slice(2)

const provenance = {
  source_repository: sourceRepository,
  source_commit: sourceCommit,
  source_version: sourceVersion,
  targets: ["arm64-apple-macosx", "x86_64-apple-macosx"],
  build_command:
    "swift build --package-path Apps/CLI --configuration release --triple <target>; strip -x <slice>; lipo -create <slices>; codesign --sign - <binary>",
  binaries: {
    peekaboo: { sha256: peekabooSha256, size_bytes: Number(peekabooSize) },
    "peekaboo-cursor-host": { sha256: cursorSha256, size_bytes: Number(cursorSize) },
  },
  swift,
}

fs.writeFileSync(output, `${JSON.stringify(provenance, null, 2)}\n`)
NODE

cp "$source_worktree/LICENSE" "$vendor_dir/LICENSE"
cp "$temporary_root/provenance.json" "$vendor_dir/provenance.json"
cp "$temporary_root/peekaboo" "$vendor_dir/peekaboo"
cp "$temporary_root/peekaboo-cursor-host" "$vendor_dir/peekaboo-cursor-host"
chmod 0644 "$vendor_dir/LICENSE" "$vendor_dir/provenance.json"
chmod 0755 "$vendor_dir/peekaboo" "$vendor_dir/peekaboo-cursor-host"

echo "Vendored Peekaboo $source_commit"
echo "peekaboo: $peekaboo_size bytes ($peekaboo_sha256)"
echo "peekaboo-cursor-host: $cursor_size bytes ($cursor_sha256)"
echo "Architectures: arm64 x86_64"
