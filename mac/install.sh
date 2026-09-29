#!/bin/sh
# planner: install the Mac automation pieces for the current user.
#   - symlinks mac/screentime_push.py to ~/bin/screentime_push.py
#   - copies the two LaunchAgent plists into ~/Library/LaunchAgents with __HOME__ / __REPO__ / __PLANNER_URL__ filled in
#     (plain str.replace + XML escaping in /usr/bin/python3, so a home folder, repo path or URL containing
#     &, |, \ or < is written correctly; sed would misread those in its replacement text)
#   - prints the Full Disk Access + Keychain steps and the launchctl commands (run them yourself, or pass --load)
#
# Usage:  sh mac/install.sh [--url https://planner.<sub>.workers.dev] [--load]
# The URL is taken from --url, else $PLANNER_URL, else ~/.config/planner/config.json ("url"), else left as a placeholder.
set -eu

REPO="$(cd "$(dirname "$0")/.." && pwd)"
URL="${PLANNER_URL:-}"
LOAD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --url=*) URL="${1#--url=}"; shift ;;
    --load) LOAD=1; shift ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
if [ -z "$URL" ] && [ -f "$HOME/.config/planner/config.json" ]; then
  URL="$(/usr/bin/python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("url",""))' "$HOME/.config/planner/config.json" 2>/dev/null || true)"
fi
URL="${URL%/}"
if [ -z "$URL" ]; then
  URL="https://planner.YOUR-SUBDOMAIN.workers.dev"
  echo "note: no Worker URL given; the screentime plist will contain a placeholder. Re-run with --url <url> after deploying."
fi

AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$HOME/bin" "$AGENTS" "$HOME/Library/Logs" "$HOME/.config/planner" "$HOME/planner-backups"
chmod 700 "$HOME/.config/planner"

ln -sfn "$REPO/mac/screentime_push.py" "$HOME/bin/screentime_push.py"
chmod +x "$REPO/mac/screentime_push.py" "$REPO/mac/backup.sh"
echo "linked  $HOME/bin/screentime_push.py -> $REPO/mac/screentime_push.py"

for name in com.pranav.planner-screentime com.pranav.planner-backup; do
  src="$REPO/mac/$name.plist"
  dst="$AGENTS/$name.plist"
  # Not sed: & and \ (and the delimiter) are special in a sed replacement, and any of them can appear in a
  # path or URL. The values are XML-escaped because they land inside <string> elements.
  /usr/bin/python3 - "$src" "$dst" "$HOME" "$REPO" "$URL" <<'PY'
import sys
from xml.sax.saxutils import escape
src, dst, home, repo, url = sys.argv[1:6]
text = open(src, encoding="utf-8").read()
for placeholder, value in (("__HOME__", home), ("__REPO__", repo), ("__PLANNER_URL__", url)):
    text = text.replace(placeholder, escape(value))
with open(dst, "w", encoding="utf-8") as f:
    f.write(text)
PY
  chmod 644 "$dst"
  plutil -lint "$dst" >/dev/null
  echo "wrote   $dst"
done

UID_NUM="$(id -u)"
cat <<EOF

Next steps (one time):

1. Full Disk Access for /usr/bin/python3 (needed to read Screen Time's knowledgeC.db):
   System Settings > Privacy & Security > Full Disk Access.
   In Finder press Cmd+Shift+G, type /usr/bin, and DRAG "python3" from that Finder window into the
   Full Disk Access list (the "+" picker was broken for bare executables on macOS 26.1-26.2; dragging works
   even when the row does not show up). Turn the switch on if one appears.
   Verify (should print a row count, not "authorization denied"):
     /usr/bin/python3 -c "import sqlite3,os;c=sqlite3.connect('file:'+os.path.expanduser('~/Library/Application Support/Knowledge/knowledgeC.db')+'?mode=ro',uri=True);print(c.execute(\"select count(*) from ZOBJECT where ZSTREAMNAME='/app/usage'\").fetchone())"
   Or check the grant directly (auth_value 2 = allowed):
     sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "select client,auth_value from access where service='kTCCServiceSystemPolicyAllFiles'"

2. Put the MAC_TOKEN in the login Keychain (it is prompted for, so it never lands in shell history):
     security add-generic-password -U -a "\$USER" -s planner-mac-token -w
   (paste the same value you gave \`npx wrangler secret put MAC_TOKEN\`). The script reads it with
   \`security find-generic-password -s planner-mac-token -w\`; if a Keychain dialog appears on the first run,
   choose "Always Allow".

3. Test once by hand, then load the agents:
     PLANNER_URL="$URL" /usr/bin/python3 ~/bin/screentime_push.py --dry-run
     launchctl bootstrap gui/$UID_NUM $AGENTS/com.pranav.planner-screentime.plist
     launchctl bootstrap gui/$UID_NUM $AGENTS/com.pranav.planner-backup.plist
     launchctl kickstart -k gui/$UID_NUM/com.pranav.planner-screentime     # run now
     tail -n 20 ~/Library/Logs/planner-screentime.log ~/Library/Logs/planner-screentime.err
   The backup agent only runs on Sundays at 09:30 (no RunAtLoad). To take a first backup now, either:
     launchctl kickstart -k gui/$UID_NUM/com.pranav.planner-backup         # through launchd, logs in ~/Library/Logs/planner-backup.*
     sh $REPO/mac/backup.sh                                                # or directly in this shell
   To reload after editing a plist: launchctl bootout gui/$UID_NUM/<label> then bootstrap again.
EOF

if [ "$LOAD" -eq 1 ]; then
  for name in com.pranav.planner-screentime com.pranav.planner-backup; do
    launchctl bootout "gui/$UID_NUM/$name" 2>/dev/null || true
    launchctl bootstrap "gui/$UID_NUM" "$AGENTS/$name.plist"
    echo "loaded  $name"
  done
  launchctl kickstart -k "gui/$UID_NUM/com.pranav.planner-screentime" || true
fi
