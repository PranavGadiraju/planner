#!/usr/bin/env bash
# Smoke test for the Worker API: applies schema.sql to an isolated local D1, starts `wrangler dev --local`,
# curls the M1 + M2 routes with each token role, then stops wrangler. Exit code 0 = every check passed.
# State lives under .wrangler/smoke-state (wiped on every run) so your normal local dev database is untouched.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-8787}"
BASE="http://127.0.0.1:${PORT}"
STATE=".wrangler/smoke-state"
LOG="${TMPDIR:-/tmp}/planner-smoke-wrangler.log"
export WRANGLER_SEND_METRICS=false

[ -d node_modules ] || { echo "node_modules missing: run npm install first" >&2; exit 1; }
[ -f .dev.vars ] || { cp .dev.vars.example .dev.vars; echo "created .dev.vars from .dev.vars.example"; }
mkdir -p dist
[ -f dist/index.html ] || printf '<!doctype html><title>planner</title><p>Run npm run build for the app.</p>\n' > dist/index.html

val() { sed -n "s/^$1=//p" .dev.vars | head -1 | tr -d '"'"'"'\r'; }
APP_TOKEN="$(val APP_TOKEN)"; SHORTCUT_TOKEN="$(val SHORTCUT_TOKEN)"; MAC_TOKEN="$(val MAC_TOKEN)"
[ -n "$APP_TOKEN" ] && [ -n "$SHORTCUT_TOKEN" ] && [ -n "$MAC_TOKEN" ] || { echo "tokens missing in .dev.vars" >&2; exit 1; }
# The Worker's TZ var decides what "today" and "local midnight" are below.
TZ_NAME="$(sed -n 's/.*"TZ"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' wrangler.jsonc | head -1)"
TZ_NAME="${TZ_NAME:-America/New_York}"

echo "== applying schema.sql to a fresh local D1 ($STATE)"
rm -rf "$STATE"
npx wrangler d1 execute planner --local --persist-to "$STATE" --file=schema.sql >/dev/null

echo "== starting wrangler dev on :$PORT (log: $LOG)"
npx wrangler dev --local --port "$PORT" --persist-to "$STATE" --test-scheduled >"$LOG" 2>&1 &
WPID=$!
cleanup() { kill "$WPID" 2>/dev/null || true; wait "$WPID" 2>/dev/null || true; }
trap cleanup EXIT

for _ in $(seq 1 90); do
  curl -fsS "$BASE/api/health" >/dev/null 2>&1 && break
  kill -0 "$WPID" 2>/dev/null || { echo "wrangler exited early:" >&2; cat "$LOG" >&2; exit 1; }
  sleep 1
done
curl -fsS "$BASE/api/health" >/dev/null || { echo "/api/health never came up:" >&2; cat "$LOG" >&2; exit 1; }

FAIL=0
# check <name> <expected status> <regex the body must match> <curl args...>
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
# check_js <name> <expected status> <JS expression over the parsed body, bound to d> <curl args...>
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
J='content-type: application/json'
APP="Authorization: Bearer $APP_TOKEN"; SC="Authorization: Bearer $SHORTCUT_TOKEN"; MAC="Authorization: Bearer $MAC_TOKEN"

# NOW, a back-dated instant for the app-role tap (10 min ago, but never before local midnight + 1 min so the tap
# lands on today), and how many whole minutes that is; near midnight the duration-dependent checks are skipped.
read -r NOW BACKDATED BACK_MIN < <(TZ_NAME="$TZ_NAME" node -e '
  const now = new Date()
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: process.env.TZ_NAME, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now)
  const g = (t) => Number(parts.find((p) => p.type === t).value)
  const sinceMidnightMs = ((g("hour") % 24) * 3600 + g("minute") * 60 + g("second")) * 1000 + now.getMilliseconds()
  const midnight = now.getTime() - sinceMidnightMs
  const back = new Date(Math.min(now.getTime(), Math.max(now.getTime() - 600000, midnight + 60000)))
  console.log(now.toISOString(), back.toISOString(), Math.floor((now.getTime() - back.getTime()) / 60000))
')
echo "== now $NOW (tz $TZ_NAME), back-dated tap at $BACKDATED ($BACK_MIN min ago)"

echo "== checks"
check "health (no auth)"            200 '"ok":true.*"today":"[0-9]{4}-'   "$BASE/api/health"
check "me without token"            401 '"error":"unauthorized"'          "$BASE/api/me"
check "me with bad token"           401 '"error":"unauthorized"'          -H 'Authorization: Bearer nope' "$BASE/api/me"
check "me (app)"                    200 '"role":"app"'                    -H "$APP" "$BASE/api/me"
check "tap shower #1 (shortcut)"    200 '"action":"routine_started"'      -X POST -H "$SC" -H "$J" -d '{"item":"shower"}' "$BASE/api/tap"
check "tap shower #2 (shortcut)"    200 '"action":"routine_duplicate"'    -X POST -H "$SC" -H "$J" -d '{"item":"shower"}' "$BASE/api/tap"
check "tap bogus (shortcut)"        400 '"ok":false.*"action":"unknown_item"' -X POST -H "$SC" -H "$J" -d '{"item":"bogus"}' "$BASE/api/tap"
check "tap with mac token"          403 '"error":"forbidden"'             -X POST -H "$MAC" -H "$J" -d '{"item":"shower"}' "$BASE/api/tap"
check "today with shortcut token"   403 '"error":"forbidden"'             -H "$SC" "$BASE/api/today"
check "tap bad JSON (shortcut)"     400 '"error":"invalid JSON"'          -X POST -H "$SC" -H "$J" -d '{nope' "$BASE/api/tap"
check "tap missing item (app)"      400 '"error":"item required"'         -X POST -H "$APP" -H "$J" -d '{}' "$BASE/api/tap"
check "tap non-object body (app)"   400 '"error":"body must be a JSON object"' -X POST -H "$APP" -H "$J" -d '[1]' "$BASE/api/tap"
check "tap bad ts (app)"            400 '"error":"ts must be an ISO timestamp"' -X POST -H "$APP" -H "$J" -d '{"item":"run","ts":"yesterday"}' "$BASE/api/tap"
check "tap run back-dated (app)"    200 '"action":"routine_started"'      -X POST -H "$APP" -H "$J" -d "{\"item\":\"run\",\"ts\":\"$BACKDATED\"}" "$BASE/api/tap"
if [ "$BACK_MIN" -ge 3 ]; then
  DONE_PAT='"action":"routine_finished".*done · '
  [ "$BACK_MIN" -eq 10 ] && DONE_PAT="${DONE_PAT}10 min"
  check "tap run again (shortcut)"  200 "$DONE_PAT" -X POST -H "$SC" -H "$J" -d '{"item":"run"}' "$BASE/api/tap"
else
  echo "skip tap run again (shortcut): only $BACK_MIN min since local midnight"
fi
check "tap winddown"                200 '"action":"winddown".*streak'     -X POST -H "$SC" -H "$J" -d '{"item":"winddown"}' "$BASE/api/tap"
check "tap wake (nothing open)"     200 '"action":"wake_duplicate"'       -X POST -H "$SC" -H "$J" -d '{"item":"wake"}' "$BASE/api/tap"
check "tap bed (time-of-day dependent)" 200 '"action":"bed'               -X POST -H "$SC" -H "$J" -d '{"item":"bed"}' "$BASE/api/tap"
check "write settings (app)"        200 '"applied":1,"rejected":\[\]'     -X POST -H "$APP" -H "$J" -d "{\"mutations\":[{\"table\":\"settings\",\"rows\":[{\"key\":\"winddown_min\",\"value\":\"45\",\"updated_at\":\"$NOW\"}]}]}" "$BASE/api/write"
check "write past-day checkin (app)" 200 '"applied":1'                    -X POST -H "$APP" -H "$J" -d "{\"mutations\":[{\"table\":\"checkins\",\"rows\":[{\"local_day\":\"2026-01-02\",\"morning_note\":\"smoke\",\"updated_at\":\"$NOW\"}]}]}" "$BASE/api/write"
check "write unknown column"        200 '"applied":0,"rejected":\[\{"table":"foods".*unknown column' -X POST -H "$APP" -H "$J" -d "{\"mutations\":[{\"table\":\"foods\",\"rows\":[{\"id\":\"f1\",\"nope\":1,\"updated_at\":\"$NOW\"}]}]}" "$BASE/api/write"
check "write block without its day column" 200 '"applied":0,"rejected":\[\{"table":"time_blocks","key":"b1","reason":"missing start_ts"' -X POST -H "$APP" -H "$J" -d "{\"mutations\":[{\"table\":\"time_blocks\",\"rows\":[{\"id\":\"b1\",\"updated_at\":\"$NOW\",\"deleted_at\":\"$NOW\"}]}]}" "$BASE/api/write"
check "write constraint failure"    200 '"applied":0,"rejected":\[\{"table":"food_log"' -X POST -H "$APP" -H "$J" -d "{\"mutations\":[{\"table\":\"food_log\",\"rows\":[{\"id\":\"l1\",\"ts\":\"$NOW\",\"local_day\":\"2026-09-28\",\"slot\":\"brunch\",\"label\":\"x\",\"kcal\":1,\"created_at\":\"$NOW\",\"updated_at\":\"$NOW\"}]}]}" "$BASE/api/write"
check "write with shortcut token"   403 '"error":"forbidden"'             -X POST -H "$SC" -H "$J" -d '{"mutations":[]}' "$BASE/api/write"
check_js "today (app)"              200 'd.routine_items[0].id === "shower" && d.health.taps_today >= 7 && d.health.apps_to_triage === 0' -H "$APP" "$BASE/api/today"
check "settings (app)"              200 '"winddown_min":45.*"weight_unit":"lb"' -H "$APP" "$BASE/api/settings"
check "tap log (app)"               200 '"taps":\[\{"id":[0-9]+.*"item":"bed"' -H "$APP" "$BASE/api/tap/log"
# newest first: the three app-role bad bodies, then the shortcut's bad JSON
check "tap log has the bad-body rows" 200 '"item":"\(bad body\)","role":"app","result":"bad_request".*"item":"\(bad body\)","role":"shortcut","result":"bad_request"' -H "$APP" "$BASE/api/tap/log"
check "automation health (app)"     200 '"source":"nfc","last_ok_at":"20[^"]*","last_error_at":"20[^"]*","last_error":"invalid JSON"' -H "$APP" "$BASE/api/health/automations"
# M2: day timeline + routine items
DAY_EXPR='[1380, 1440, 1500].includes(d.minutes) && d.is_today === true && d.totals.tracked_s === d.now_min * 60
  && Object.entries(d.totals).filter(([k]) => k !== "tracked_s").reduce((a, [, v]) => a + v, 0) === d.now_min * 60
  && d.blocks.reduce((a, b) => a + b.minutes, 0) === d.now_min
  && Array.isArray(d.routine_items) && d.routine_items.length >= 5 && d.routine_items.every((i) => i.active === 1) && Array.isArray(d.projects)'
if [ "$BACK_MIN" -ge 3 ]; then
  DAY_EXPR="$DAY_EXPR && d.blocks.some((b) => b.source === 'routine')"
else
  echo "skip routine-block assertion on /api/day/today: only $BACK_MIN min since local midnight"
fi
check_js "day today (app)"          200 "$DAY_EXPR" -H "$APP" "$BASE/api/day/today"
check_js "day past date (app)"      200 'd.day === "2026-01-02" && d.is_today === false && d.minutes === 1440 && d.now_min === 1440 && d.totals.unknown_s === 86400 && d.gaps.length === 1 && d.blocks.length === 1' -H "$APP" "$BASE/api/day/2026-01-02"
check "day bad date"                400 '"error":"date must be YYYY-MM-DD or today"' -H "$APP" "$BASE/api/day/2026-13-45"
check "day with shortcut token"     403 '"error":"forbidden"'             -H "$SC" "$BASE/api/day/today"
check "day wrong method"            405 '"error":"method not allowed"'    -X POST -H "$APP" "$BASE/api/day/today"
check "day without date"            404 '"error":"not found"'             -H "$APP" "$BASE/api/day"
check_js "routine items (app)"      200 'Array.isArray(d.items) && d.items.length >= 5 && d.items.some((i) => i.id === "run")' -H "$APP" "$BASE/api/routine-items"
check "unknown route"               404 '"error":"not found"'             -H "$APP" "$BASE/api/nope"
check "wrong method"                405 '"error":"method not allowed"'    -X POST -H "$APP" "$BASE/api/today"
# /__scheduled is shadowed by the assets SPA fallback; wrangler's /cdn-cgi path is reserved and always reaches the Worker.
check "scheduled (prune tap_log)"   200 '^ok$'                            "$BASE/cdn-cgi/handler/scheduled?cron=5+8+*+*+*"
check "cron left a health row"      200 '"source":"cron","last_ok_at":"20' -H "$APP" "$BASE/api/health/automations"
check "static fallback"             200 'planner'                         "$BASE/"

# Per-area smoke scripts (scripts/smoke-<area>.sh) run against the same server with the same tokens.
for extra in scripts/smoke-*.sh; do
  [ -f "$extra" ] || continue
  echo "== running $extra"
  if BASE="$BASE" APP_TOKEN="$APP_TOKEN" SHORTCUT_TOKEN="$SHORTCUT_TOKEN" MAC_TOKEN="$MAC_TOKEN" TZ_NAME="$TZ_NAME" bash "$extra"; then echo "ok   $extra"; else echo "FAIL $extra"; FAIL=1; fi
done
if [ "$FAIL" = 0 ]; then echo "== smoke passed"; else echo "== smoke FAILED (wrangler log: $LOG)"; exit 1; fi
