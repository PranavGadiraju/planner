#!/bin/sh
# planner: weekly D1 backup.
#   npx wrangler d1 export planner --remote --output ~/planner-backups/<date>.sql
# Run from the repo directory (wrangler.jsonc names the database and wrangler is a devDependency there).
# Called by ~/Library/LaunchAgents/com.pranav.planner-backup.plist; also fine to run by hand: sh mac/backup.sh
# Keeps the last 12 dumps. Needs `npx wrangler login` to have been done once for this user.
set -eu

REPO="${PLANNER_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
OUT_DIR="${PLANNER_BACKUP_DIR:-$HOME/planner-backups}"
KEEP="${PLANNER_BACKUP_KEEP:-12}"

# launchd starts with a minimal PATH; make sure a Homebrew / nvm / volta node is found.
export PATH="$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -z "$(command -v node || true)" ] && [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true
fi
if [ -z "$(command -v npx || true)" ]; then
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) error: npx not found on PATH ($PATH)" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
cd "$REPO"
STAMP="$(date +%Y-%m-%d)"
FILE="$OUT_DIR/$STAMP.sql"

echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) exporting planner (remote) -> $FILE"
npx --no-install wrangler d1 export planner --remote --output "$FILE"
SIZE="$(wc -c < "$FILE" | tr -d ' ')"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ok: $FILE ($SIZE bytes)"

# prune: keep the newest $KEEP dumps
ls -1t "$OUT_DIR"/*.sql 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) pruning $old"
  rm -f "$old"
done
