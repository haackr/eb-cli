#!/usr/bin/env bash
set -euo pipefail

# eb CLI installer for Linux
# Usage:
#   curl -fsSL https://eb-cli-updates-934677684919-us-east-2-an.s3.us-east-2.amazonaws.com/install.sh | bash
#   curl -fsSL https://eb-cli-updates-934677684919-us-east-2-an.s3.us-east-2.amazonaws.com/channels/alpha/install.sh | CHANNEL=alpha bash
#   INSTALL_DIR=/opt/eb bash install.sh

S3_HOST="https://eb-cli-updates-934677684919-us-east-2-an.s3.us-east-2.amazonaws.com"
CHANNEL="${CHANNEL:-stable}"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/lib/eb}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
BIN="eb"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  TARGET="linux-x64" ;;
  aarch64) TARGET="linux-arm64" ;;
  armv7l)  TARGET="linux-arm" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

TARBALL_URL="$S3_HOST/channels/$CHANNEL/$BIN-$TARGET.tar.gz"

echo "Installing eb CLI..."
echo "  Channel:  $CHANNEL"
echo "  Target:   $TARGET"
echo "  URL:      $TARBALL_URL"
echo "  Install:  $INSTALL_DIR"
echo ""

# Check for required tools
for cmd in curl tar; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not installed."
    exit 1
  fi
done

# Create directories
mkdir -p "$INSTALL_DIR" "$BIN_DIR"

# Download and extract
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading..."
curl -fsSL "$TARBALL_URL" -o "$TMP_DIR/eb.tar.gz"

echo "Extracting..."
tar -xzf "$TMP_DIR/eb.tar.gz" -C "$TMP_DIR"

# oclif tarballs extract to a directory named after the bin
EXTRACTED=$(find "$TMP_DIR" -maxdepth 1 -type d -name "$BIN" | head -1)
if [ -z "$EXTRACTED" ]; then
  # fallback: first subdirectory
  EXTRACTED=$(find "$TMP_DIR" -maxdepth 1 -mindepth 1 -type d | head -1)
fi

if [ -z "$EXTRACTED" ]; then
  echo "Error: Could not find extracted contents."
  exit 1
fi

# Replace existing install
rm -rf "$INSTALL_DIR"
mv "$EXTRACTED" "$INSTALL_DIR"

# Symlink binary
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/$BIN" "$BIN_DIR/$BIN"

echo ""
echo "eb CLI installed successfully."

# PATH reminder
if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  echo ""
  echo "  Note: $BIN_DIR is not in your PATH."
  echo "  Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
  echo ""
  echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  echo ""
fi

echo "Run 'eb --version' to verify the installation."
