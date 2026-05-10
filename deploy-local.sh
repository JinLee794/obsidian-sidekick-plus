#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/.deploy-local.conf"

# ── Resolve vault path ──────────────────────────────────────────────
if [[ -f "$CONFIG_FILE" ]]; then
  VAULT="$(cat "$CONFIG_FILE")"
else
  echo "No saved vault path found."
  read -rp "Enter the path to your Obsidian vault: " VAULT
  # Expand ~ and common shell variables ($HOME, $USER)
  VAULT="${VAULT/#\~/$HOME}"
  VAULT="${VAULT//\$HOME/$HOME}"
  VAULT="${VAULT//\$USER/$USER}"
  # Strip trailing slash
  VAULT="${VAULT%/}"
fi

# Validate the directory is an Obsidian vault
if [[ ! -d "$VAULT/.obsidian" ]]; then
  echo "✗ '$VAULT' is not a valid Obsidian vault (missing .obsidian directory)." >&2
  # Clear any stale config so the user is prompted again next time
  rm -f "$CONFIG_FILE"
  exit 1
fi
# Persist for next run (only after validation passes)
if [[ ! -f "$CONFIG_FILE" ]] || [[ "$(cat "$CONFIG_FILE")" != "$VAULT" ]]; then
  echo "$VAULT" > "$CONFIG_FILE"
  echo "✓ Vault path saved to .deploy-local.conf"
fi

PLUGIN_DIR="$VAULT/.obsidian/plugins/sidekick-plus"

# ── Build & deploy ──────────────────────────────────────────────────
npm run build

mkdir -p "$PLUGIN_DIR"
cp main.js manifest.json styles.css "$PLUGIN_DIR/"

echo "✓ Deployed to $PLUGIN_DIR"

# Reload if Obsidian CLI is available
if command -v obsidian &>/dev/null; then
  obsidian plugin:reload id=sidekick-plus && echo "✓ Plugin reloaded"
fi
