#!/usr/bin/env sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
ARTIFACT_DIR="$ROOT_DIR/artifacts/sea"
WORK_DIR="$ROOT_DIR/.sea-work/test-install-unix"
RELEASE_DIR="$WORK_DIR/local-release/test-release"
HOME_DIR="$WORK_DIR/home"

mkdir -p "$RELEASE_DIR" "$HOME_DIR"

case "$(uname -s)" in
  Darwin) PLATFORM=darwin ;;
  Linux) PLATFORM=linux ;;
  *) echo "Unsupported test platform" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64) ARCH=x64 ;;
  *) echo "Unsupported test architecture" >&2; exit 1 ;;
esac
ASSET_BASE="vana-$PLATFORM-$ARCH"
cp "$ARTIFACT_DIR/$ASSET_BASE.tar.gz" "$RELEASE_DIR/$ASSET_BASE.tar.gz"
cp "$ARTIFACT_DIR/$ASSET_BASE.tar.gz.sha256" "$RELEASE_DIR/$ASSET_BASE.tar.gz.sha256"

VANA_VERSION=test-release \
VANA_RELEASE_BASE_URL="file://$WORK_DIR/local-release" \
VANA_INSTALL_ROOT="$HOME_DIR/root" \
VANA_INSTALL_BIN_DIR="$HOME_DIR/bin" \
HOME="$HOME_DIR" \
sh "$ROOT_DIR/install/install.sh"

PATH="$HOME_DIR/bin:$PATH" HOME="$HOME_DIR" "$HOME_DIR/bin/vana" status --json >/dev/null

echo "Unix installer smoke test passed"

python3 "$ROOT_DIR/scripts/test-onboarding.py" \
  --installer "$ROOT_DIR/install/install.sh" \
  --version test-release \
  --release-base-url "file://$WORK_DIR/local-release" \
  --evidence "$WORK_DIR/onboarding-proof.json"
