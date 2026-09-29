#!/usr/bin/env bash
# M6 smoke: the POST /api/screentime contract, GET /api/apps and a category write. scripts/smoke.sh runs this against
# its isolated wrangler dev with BASE, APP_TOKEN, SHORTCUT_TOKEN, MAC_TOKEN and TZ_NAME exported; exit 0 = all passed.
# When /usr/bin/python3 exists it also drives the real mac/screentime_push.py against a fake knowledgeC.db twice
# (watermark + 3 h overlap) and checks that nothing is double-counted.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
: "${BASE:?BASE required}" "${APP_TOKEN:?APP_TOKEN required}" "${SHORTCUT_TOKEN:?SHORTCUT_TOKEN required}" "${MAC_TOKEN:?MAC_TOKEN required}"
TZ_NAME="${TZ_NAME:-America/New_York}"

FAIL=0
check() {
  local name="$1" want="$2" pat="$3"; shift 3
  local out status body
  out="$(curl -sS -o - -w $'\n%{http_code}' "$@")"
  status="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$status" = "$want" ] && printf '%s' "$body" | grep -Eq -- "$pat"; then
    echo "ok   $name -> $status ${body:0:160}"
  else
    echo "FAIL $name -> want $want /$pat/, got $status $body"; FAIL=1
  fi
}
check_js() {
  local name="$1" want="$2" expr="$3"; shift 3
  local out status body
  out="$(curl -sS -o - -w $'\n%{http_code}' "$@")"
  status="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$status" = "$want" ] && printf '%s' "$body" | EXPR="$expr" node -e '
      let s = ""
      process.stdin.on("data", (c) => (s += c)).on("end", () => {
        let ok = false
        try { ok = !!new Function("d", "return (" + process.env.EXPR + ")")(JSON.parse(s)) } catch (e) { console.error(String(e)) }
        process.exit(ok ? 0 : 1)
      })'; then
    echo "ok   $name -> $status ${body:0:160}"
  else
    echo "FAIL $name -> want $want and [$expr], got $status ${body:0:600}"; FAIL=1
  fi
}
# local_day <ISO> -> YYYY-MM-DD in TZ_NAME (same Intl maths as src/shared/tz.ts)
local_day() { TZ_NAME="$TZ_NAME" ISO="$1" node -e 'console.log(new Intl.DateTimeFormat("en-CA", { timeZone: process.env.TZ_NAME, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(process.env.ISO)))'; }
J='content-type: application/json'
APP="Authorization: Bearer $APP_TOKEN"; SC="Authorization: Bearer $SHORTCUT_TOKEN"; MAC="Authorization: Bearer $MAC_TOKEN"

# A fixed past window so the assertions are exact: 14:00-16:00 UTC on Mon 2026-01-05 (09:00-11:00 EST).
FROM='2026-01-05T14:00:00.000Z'; TO='2026-01-05T16:00:00.000Z'
DAY="$(local_day "$FROM")"
EDITOR='com.smoke.editor'; BROWSER='com.smoke.browser'
FULL="{\"source\":\"mac\",\"device\":\"smoke-mac\",\"window\":{\"from\":\"$FROM\",\"to\":\"$TO\"},
  \"hours\":[{\"hour_start\":\"2026-01-05T14:00:00.000Z\",\"app_id\":\"$EDITOR\",\"seconds\":1800},
            {\"hour_start\":\"2026-01-05T14:00:00.000Z\",\"app_id\":\"$BROWSER\",\"seconds\":900},
            {\"hour_start\":\"2026-01-05T15:00:00.000Z\",\"app_id\":\"$EDITOR\",\"seconds\":3600}],
  \"intervals\":[{\"start\":\"2026-01-05T14:00:00.000Z\",\"end\":\"2026-01-05T14:45:00.000Z\",\"top_app\":\"$EDITOR\"},
                {\"start\":\"2026-01-05T15:00:00.000Z\",\"end\":\"2026-01-05T16:00:00.000Z\",\"top_app\":\"$EDITOR\"}],
  \"apps\":[{\"app_id\":\"$EDITOR\",\"label\":\"Smoke Editor\"},{\"app_id\":\"$BROWSER\",\"label\":null}]}"
# The same window with only the second hour: a re-send must drop what it no longer carries.
PARTIAL="{\"source\":\"mac\",\"device\":\"smoke-mac\",\"window\":{\"from\":\"$FROM\",\"to\":\"$TO\"},
  \"hours\":[{\"hour_start\":\"2026-01-05T15:00:00.000Z\",\"app_id\":\"$EDITOR\",\"seconds\":3600}],
  \"intervals\":[{\"start\":\"2026-01-05T15:00:00.000Z\",\"end\":\"2026-01-05T16:00:00.000Z\",\"top_app\":\"$EDITOR\"}]}"
PHONE="{\"source\":\"phone\",\"device\":\"iphone\",\"window\":{\"from\":\"$TO\",\"to\":\"2026-01-05T17:00:00.000Z\"},
  \"hours\":[{\"hour_start\":\"$TO\",\"app_id\":\"_total\",\"seconds\":1200}]}"
DAY_EXPR="d.day === '$DAY' && d.totals.mac_s === 6300 && d.mac_by_category.other === 6300 && d.blocks.some((b) => b.category === 'mac' && b.source === 'mac' && b.label === 'Smoke Editor')"

echo "== screentime: window $FROM -> $TO (local day $DAY in $TZ_NAME)"
check_js "screentime mac 2 h window (mac)"  200 "d.hours === 3 && d.intervals === 2 && d.apps_new === 2 && JSON.stringify(d.days) === '[\"$DAY\"]'" -X POST -H "$MAC" -H "$J" -d "$FULL" "$BASE/api/screentime"
check_js "day shows the mac blocks"         200 "$DAY_EXPR" -H "$APP" "$BASE/api/day/$DAY"
check_js "re-POST the same window"          200 'd.hours === 3 && d.intervals === 2 && d.apps_new === 0' -X POST -H "$MAC" -H "$J" -d "$FULL" "$BASE/api/screentime"
check_js "day mac_s unchanged after re-POST" 200 "$DAY_EXPR" -H "$APP" "$BASE/api/day/$DAY"
check_js "apps: both bundle ids, null category first, seen_seconds accumulate" 200 \
  "d.apps[0].app_id === '$EDITOR' && d.apps[0].category === null && d.apps[0].label === 'Smoke Editor' && d.apps[0].seen_seconds === 10800
   && d.apps[1].app_id === '$BROWSER' && d.apps[1].category === null && d.apps[1].label === null && d.apps[1].seen_seconds === 1800
   && d.apps.every((a) => a.deleted_at === null) && d.apps.some((a) => a.app_id === 'com.apple.Safari' && a.category === 'browsing')" \
  -H "$APP" "$BASE/api/apps"
check_js "re-POST a subset replaces the window" 200 'd.hours === 1 && d.intervals === 1 && d.apps_new === 0' -X POST -H "$MAC" -H "$J" -d "$PARTIAL" "$BASE/api/screentime"
check_js "day dropped the hour no longer sent" 200 "d.totals.mac_s === 3600 && d.mac_by_category.other === 3600" -H "$APP" "$BASE/api/day/$DAY"
check_js "restore the full window"          200 'd.hours === 3 && d.intervals === 2' -X POST -H "$MAC" -H "$J" -d "$FULL" "$BASE/api/screentime"
check "screentime hours [] (mac)"           400 '"error":"hours must not be empty' -X POST -H "$MAC" -H "$J" -d "{\"source\":\"mac\",\"device\":\"smoke-mac\",\"window\":{\"from\":\"$FROM\",\"to\":\"$TO\"},\"hours\":[]}" "$BASE/api/screentime"
check "screentime with shortcut token"      403 '"error":"forbidden"' -X POST -H "$SC" -H "$J" -d "$FULL" "$BASE/api/screentime"
check "screentime source phone with mac token" 403 "\"error\":\"the mac token may only send source 'mac'\"" -X POST -H "$MAC" -H "$J" -d "$PHONE" "$BASE/api/screentime"
check "screentime hour_start off the hour"  400 '"error":"hours\[0\].hour_start must be at minute 0' -X POST -H "$MAC" -H "$J" -d "{\"source\":\"mac\",\"device\":\"x\",\"window\":{\"from\":\"$FROM\",\"to\":\"$TO\"},\"hours\":[{\"hour_start\":\"2026-01-05T14:30:00.000Z\",\"app_id\":\"a\",\"seconds\":1}]}" "$BASE/api/screentime"
check "screentime seconds over 3600"        400 'seconds must be an integer between 0 and 3600' -X POST -H "$MAC" -H "$J" -d "{\"source\":\"mac\",\"device\":\"x\",\"window\":{\"from\":\"$FROM\",\"to\":\"$TO\"},\"hours\":[{\"hour_start\":\"$FROM\",\"app_id\":\"a\",\"seconds\":3601}]}" "$BASE/api/screentime"
check "screentime window over 48 h"         400 '"error":"window must be at most 48 hours"' -X POST -H "$MAC" -H "$J" -d "{\"source\":\"mac\",\"device\":\"x\",\"window\":{\"from\":\"2026-01-03T13:00:00.000Z\",\"to\":\"$TO\"},\"hours\":[{\"hour_start\":\"$FROM\",\"app_id\":\"a\",\"seconds\":1}]}" "$BASE/api/screentime"
check "screentime hour outside the window"  400 'hour_start is outside the window' -X POST -H "$MAC" -H "$J" -d "{\"source\":\"mac\",\"device\":\"x\",\"window\":{\"from\":\"$FROM\",\"to\":\"$TO\"},\"hours\":[{\"hour_start\":\"$TO\",\"app_id\":\"a\",\"seconds\":1}]}" "$BASE/api/screentime"
check "screentime missing window"           400 '"error":"window \{from, to\} required"' -X POST -H "$MAC" -H "$J" -d '{"source":"mac","device":"x","hours":[]}' "$BASE/api/screentime"
check "screentime bad JSON"                 400 '"error":"invalid JSON"' -X POST -H "$MAC" -H "$J" -d '{nope' "$BASE/api/screentime"
check_js "screentime phone totals (app)"    200 'd.hours === 1 && d.intervals === 0 && d.apps_new === 0' -X POST -H "$APP" -H "$J" -d "$PHONE" "$BASE/api/screentime"
check_js "day shows the phone minutes"      200 "d.totals.phone_s === 1200 && d.totals.mac_s === 6300 && d.blocks.some((b) => b.category === 'phone')" -H "$APP" "$BASE/api/day/$DAY"
check_js "apps never lists _total"          200 "d.apps.every((a) => a.app_id !== '_total') && d.apps.filter((a) => a.category === null).length === 2" -H "$APP" "$BASE/api/apps"
check "apps with shortcut token"            403 '"error":"forbidden"' -H "$SC" "$BASE/api/apps"
check "apps with mac token"                 403 '"error":"forbidden"' -H "$MAC" "$BASE/api/apps"
check "automation health has mac + phone"   200 '"source":"mac","last_ok_at":"20[^"]*","last_error_at":[^,]*,"last_error":[^,]*,"detail":"3 hours / 2 intervals".*"source":"phone","last_ok_at":"20[^"]*".*"detail":"1 hours / 0 intervals"' -H "$APP" "$BASE/api/health/automations"
check_js "today: triage count + last hours" 200 "d.health.apps_to_triage === 2 && d.health.mac_last_hour === '2026-01-05T15:00:00.000Z' && d.health.phone_last_hour === '$TO'" -H "$APP" "$BASE/api/today"
check_js "day freshness: last mac/phone hour + mac last ok" 200 "d.freshness.mac_last_hour === '2026-01-05T15:00:00.000Z' && d.freshness.phone_last_hour === '$TO' && /^20[0-9]{2}-/.test(d.freshness.mac_last_ok_at)" -H "$APP" "$BASE/api/day/$DAY"

# Categorise one app the way the PWA does (outbox -> /api/write), then confirm the list and the counters follow.
LATER="$(node -e 'console.log(new Date(Date.now() + 1000).toISOString())')"
check "write category via /api/write (app)" 200 '"applied":1,"rejected":\[\]' -X POST -H "$APP" -H "$J" -d "{\"mutations\":[{\"table\":\"app_categories\",\"rows\":[{\"app_id\":\"$EDITOR\",\"label\":\"Smoke Editor\",\"category\":\"dev\",\"updated_at\":\"$LATER\",\"deleted_at\":null}]}]}" "$BASE/api/write"
check_js "apps shows the category"          200 "d.apps[0].app_id === '$BROWSER' && d.apps[0].category === null && d.apps.find((a) => a.app_id === '$EDITOR').category === 'dev'" -H "$APP" "$BASE/api/apps"
check_js "day tints the editor as dev"      200 "d.mac_by_category.dev === 5400 && d.mac_by_category.other === 900 && d.blocks.some((b) => b.category === 'mac' && b.sub === 'dev')" -H "$APP" "$BASE/api/day/$DAY"
check_js "re-POST keeps the category"       200 'd.apps_new === 0' -X POST -H "$MAC" -H "$J" -d "$FULL" "$BASE/api/screentime"
# five mac posts so far carried 5400 + 5400 + 3600 + 5400 + 5400 editor seconds (re-sends count: it only ranks the list)
check_js "apps: category survives, seen_seconds keep counting" 200 "d.apps.find((a) => a.app_id === '$EDITOR').category === 'dev' && d.apps.find((a) => a.app_id === '$EDITOR').seen_seconds === 25200" -H "$APP" "$BASE/api/apps"
check "write a bad category is rejected"    200 '"applied":0,"rejected":\[\{"table":"app_categories","key":"'"$EDITOR"'"' -X POST -H "$APP" -H "$J" -d "{\"mutations\":[{\"table\":\"app_categories\",\"rows\":[{\"app_id\":\"$EDITOR\",\"category\":\"games\",\"updated_at\":\"$LATER\"}]}]}" "$BASE/api/write"
check_js "today: one app left to triage"    200 'd.health.apps_to_triage === 1' -H "$APP" "$BASE/api/today"

# ---- the real Mac script against a fake knowledgeC.db (macOS only: /usr/bin/python3 + mdfind)
PY=/usr/bin/python3
if [ -x "$PY" ]; then
  WORK="$(mktemp -d "${TMPDIR:-/tmp}/planner-smoke-mac.XXXXXX")"
  FAKE="$WORK/knowledgeC.db"; CFG="$WORK/config"
  # Two apps in [now-2h, now-1h): 30 min editor then 30 min browser, whole minutes so the seconds are exact;
  # a dock row (ignored) and a row from another device (excluded) must not leak in.
  "$PY" - "$FAKE" "$WORK/times" <<'PYEOF'
import sqlite3, sys, time
db, times = sys.argv[1], sys.argv[2]
OFF = 978307200
now = int(time.time()) // 60 * 60
c = sqlite3.connect(db)
c.executescript("""
CREATE TABLE ZOBJECT (Z_PK INTEGER PRIMARY KEY, ZSTREAMNAME TEXT, ZVALUESTRING TEXT, ZSTARTDATE REAL, ZENDDATE REAL, ZSOURCE INTEGER);
CREATE TABLE ZSOURCE (Z_PK INTEGER PRIMARY KEY, ZDEVICEID TEXT);
INSERT INTO ZSOURCE VALUES (1, NULL), (2, 'iphone-remote');
""")
rows = [
  ('/app/usage', 'com.fake.Editor',  now - 7200, now - 5400, 1),
  ('/app/usage', 'com.fake.Browser', now - 5400, now - 3600, 1),
  ('/app/usage', 'com.apple.dock',   now - 3600, now - 3000, 1),
  ('/app/usage', 'com.fake.Phone',   now - 7000, now - 6000, 2),
]
c.executemany("INSERT INTO ZOBJECT (ZSTREAMNAME, ZVALUESTRING, ZSTARTDATE, ZENDDATE, ZSOURCE) VALUES (?, ?, ?, ?, ?)",
              [(s, b, a - OFF, e - OFF, src) for s, b, a, e, src in rows])
c.commit(); c.close()
with open(times, "w") as f:
    f.write("{} {}\n".format(now - 7200, now - 3600))
PYEOF
  read -r FAKE_START FAKE_END < "$WORK/times"
  DAY_A="$(local_day "$(node -e "console.log(new Date($FAKE_START*1000).toISOString())")")"
  DAY_B="$(local_day "$(node -e "console.log(new Date(($FAKE_END-1)*1000).toISOString())")")"
  # sum of raw mac seconds over the day(s) the fake hour touches
  mac_seconds() {
    local total=0 d
    for d in $(printf '%s\n%s\n' "$DAY_A" "$DAY_B" | sort -u); do
      total=$((total + $(curl -sS -H "$APP" "$BASE/api/day/$d" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);console.log(Object.values(d.mac_by_category||{}).reduce((a,b)=>a+b,0))})')))
    done
    echo "$total"
  }
  run_push() {
    PLANNER_URL="$BASE" PLANNER_MAC_TOKEN="$MAC_TOKEN" PLANNER_KNOWLEDGEC_PATH="$FAKE" PLANNER_CONFIG_DIR="$CFG" "$PY" mac/screentime_push.py 2>&1
  }
  echo "== mac/screentime_push.py against a fake knowledgeC.db (rows $DAY_A..$DAY_B)"
  BEFORE="$(mac_seconds)"
  # the hour starts at a whole minute, so the two apps land in 2 hour rows, or 3 when one straddles a UTC hour boundary
  if OUT="$(run_push)" && printf '%s' "$OUT" | grep -Eq 'ok: POST .* -> 200 \([23] hour rows, 1 intervals\)'; then
    echo "ok   push #1 -> $(printf '%s' "$OUT" | grep -E 'ok: POST' | head -1)"
  else
    echo "FAIL push #1:"; printf '%s\n' "$OUT"; FAIL=1
  fi
  if [ -f "$CFG/last_run" ] && grep -Eq '^20[0-9]{2}-[0-9]{2}-[0-9]{2}T' "$CFG/last_run"; then echo "ok   watermark written $(cat "$CFG/last_run")"; else echo "FAIL watermark missing"; FAIL=1; fi
  AFTER1="$(mac_seconds)"
  if [ "$((AFTER1 - BEFORE))" = 3600 ]; then echo "ok   day carries 3600 s of fake mac time"; else echo "FAIL expected +3600 s of mac time, got $BEFORE -> $AFTER1"; FAIL=1; fi
  check_js "day has the fake mac block"     200 "d.blocks.some((b) => b.category === 'mac' && (b.label === 'Editor' || b.label === 'Browser'))" -H "$APP" "$BASE/api/day/$DAY_B"
  # second run: window = [watermark - 3 h, now) floored to the hour -> the same rows are re-sent and replaced, not added
  if OUT="$(run_push)" && printf '%s' "$OUT" | grep -Eq 'ok: POST .* -> 200 \([23] hour rows, 1 intervals\)' && printf '%s' "$OUT" | grep -Eq '^[^ ]+ window 20[^ ]*:00:00\.000Z -> '; then
    echo "ok   push #2 (hour-aligned window) -> $(printf '%s' "$OUT" | grep -E '^[^ ]+ window' | head -1)"
  else
    echo "FAIL push #2:"; printf '%s\n' "$OUT"; FAIL=1
  fi
  AFTER2="$(mac_seconds)"
  if [ "$AFTER2" = "$AFTER1" ]; then echo "ok   no duplicates after the second push ($AFTER2 s)"; else echo "FAIL mac seconds changed on re-push: $AFTER1 -> $AFTER2"; FAIL=1; fi
  check_js "apps lists the fake bundle ids uncategorised" 200 "['com.fake.Editor', 'com.fake.Browser'].every((id) => d.apps.some((a) => a.app_id === id && a.category === null)) && d.apps.every((a) => a.app_id !== 'com.apple.dock' && a.app_id !== 'com.fake.Phone')" -H "$APP" "$BASE/api/apps"
  # token-file fallback: a group/other-readable mac_token is refused, a chmod 600 one is read (Keychain lookup stubbed out, env unset)
  if PLANNER_CONFIG_DIR="$CFG" "$PY" - <<'PYEOF'
import importlib.util, os, sys
spec = importlib.util.spec_from_file_location("sp", "mac/screentime_push.py")
sp = importlib.util.module_from_spec(spec); spec.loader.exec_module(sp)
class Miss:
    returncode = 1
    stdout = ""
sp.subprocess.run = lambda *a, **k: Miss()  # never touch the real Keychain from a smoke test
os.environ.pop("PLANNER_MAC_TOKEN", None)
os.makedirs(sp.CONFIG_DIR, exist_ok=True)
with open(sp.TOKEN_FILE, "w") as f:
    f.write("smoke-file-token\n")
os.chmod(sp.TOKEN_FILE, 0o644)
loose = sp.read_token()
os.chmod(sp.TOKEN_FILE, 0o600)
tight = sp.read_token()
os.remove(sp.TOKEN_FILE)
sys.exit(0 if loose is None and tight == "smoke-file-token" else 1)
PYEOF
  then echo "ok   mac_token file refused at mode 644, read at 600"; else echo "FAIL mac_token permission check"; FAIL=1; fi
  rm -rf "$WORK"
else
  echo "skip mac/screentime_push.py run: $PY not found"
fi

# ---- a study block inside the Mac window lists the top Mac apps in it: hour 14 UTC holds editor 1800 s + browser 900 s,
# the block covers half of it -> 900 / 450 (pro-rated hour rows); the browser has no label so its bundle's short name is used.
check_js "time-block: study 14:00-14:30 UTC (app)" 201 "d.ids.length === 1 && d.blocks[0].category === 'study'" -X POST -H "$APP" -H "$J" -d "{\"blocks\":[{\"start\":\"2026-01-05T14:00:00Z\",\"end\":\"2026-01-05T14:30:00Z\",\"category\":\"study\",\"label\":\"smoke study\"}],\"day\":\"$DAY\"}" "$BASE/api/time-blocks"
check_js "day: the study block carries its top Mac apps" 200 "(() => { const b = d.blocks.find((x) => x.category === 'study' && x.label === 'smoke study'); return !!b && b.minutes === 30 && JSON.stringify(b.apps) === JSON.stringify([{ label: 'Smoke Editor', seconds: 900 }, { label: 'browser', seconds: 450 }]) && d.blocks.filter((x) => x.category !== 'study').every((x) => x.apps === undefined) && d.totals.study_s === 1800 && d.totals.mac_s === 5400 })()" -H "$APP" "$BASE/api/day/$DAY"

if [ "$FAIL" = 0 ]; then echo "== screentime smoke passed"; else echo "== screentime smoke FAILED"; exit 1; fi
