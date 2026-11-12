#!/usr/bin/env bash
# Copies versioned installers to version-free names for evergreen download links:
#   eb-v1.2.3-abc1234-arm64.pkg  -> eb-macos-arm64.pkg
#   eb-v1.2.3-abc1234-x64.exe    -> eb-windows-x64.exe
#   eb_1.2.3.abc1234-1_amd64.deb -> eb-linux-amd64.deb
# Usage: stable-installer-names.sh <macos|windows|linux> <out-dir> <installer>...
set -euo pipefail

platform="$1"
out_dir="$2"
shift 2
mkdir -p "$out_dir"

count=0
for file in "$@"; do
  [ -f "$file" ] || continue
  name="$(basename "$file")"
  ext="${name##*.}"
  base="${name%.*}"
  case "$ext" in
    deb) arch="${base##*_}" ;; # eb_1.2.3.sha-1_amd64
    *) arch="${base##*-}" ;;   # eb-v1.2.3-sha-arm64
  esac
  cp "$file" "$out_dir/eb-$platform-$arch.$ext"
  echo "$name -> eb-$platform-$arch.$ext"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "No installers matched: $*" >&2
  exit 1
fi
