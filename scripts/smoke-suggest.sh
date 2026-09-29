#!/usr/bin/env bash
# M8 smoke: Mac-derived session suggestions (GET /api/work/suggestions). Run by scripts/smoke.sh against its
# isolated wrangler dev with BASE, APP_TOKEN, SHORTCUT_TOKEN, MAC_TOKEN and TZ_NAME exported; exit 0 = all passed.
# Posts a 2 h VS Code block as the Mac (hour rows + one interval) that ended an hour ago, expects one 120 min
# suggestion, logs a session over its middle 30 min and expects two 45 min ones, then tombstones that session (the
# work smoke counts today's sessions exactly) and expects the single block back: a deleted row claims nothing.
set -euo pipefail
: "${BASE:?BASE required}" "${APP_TOKEN:?APP_TOKEN required}" "${SHORTCUT_TOKEN:?SHORTCUT_TOKEN required}" "${MAC_TOKEN:?MAC_TOKEN required}"
TZ_NAME="${TZ_NAME:-America/New_York}"

J='content-type: application/json'
APP="Authorization: Bearer $APP_TOKEN"; SC="Authorization: Bearer $SHORTCUT_TOKEN"; MAC="Authorization: Bearer $MAC_TOKEN"
FAIL=0
LAST_BODY=""

# check_js <name> <expected status> <JS expression over the parsed body, bound to d> <curl args...>
check_js() {
  local name="$1" want="$2" expr="$3"; shift 3
  local out status body
  out="$(curl -sS -o - -w $'\n%{http_code}' "$@")"
  status="${out##*$'\n'}"; body="${out%$'\n'*}"
  LAST_BODY="$body"
  if [ "$status" = "$want" ] && printf '%s' "$body" | EXPR="$expr" node -e '
      let s = ""
      process.stdin.on("data", (c) => (s += c)).on("end", () => {
        let ok = false
        try { ok = !!new Function("d", "return (" + process.env.EXPR + ")")(JSON.parse(s)) } catch (e) { console.error(String(e)) }
        process.exit(ok ? 0 : 1)
      })'; then
    echo "ok   suggest: $name -> $status ${body:0:160}"
  else
    echo "FAIL suggest: $name -> want $want and [$expr], got $status ${body:0:600}"; FAIL=1
  fi
}
# jsval <JS expression over the parsed LAST_BODY> -> prints the value
jsval() {
  printf '%s' "$LAST_BODY" | EXPR="$1" node -e '
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => { process.stdout.write(String(new Function("d", "return (" + process.env.EXPR + ")")(JSON.parse(s)))) })'
}

# The block is [now - 3 h, now - 1 h) to the minute when that start is still today in TZ_NAME (so it is wholly in the
# past and clear of the routine taps the main smoke made minutes ago); with fewer than 3 h since local midnight it is
# the same length ending two hours before midnight, i.e. on yesterday, and yesterday is what gets queried.
read -r TODAY DAY START END MID_START MID_END BODY < <(TZ_NAME="$TZ_NAME" node -e '
  const tz = process.env.TZ_NAME
  const now = new Date()
  const dayOf = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d)
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(now)
  const g = (t) => Number(parts.find((p) => p.type === t).value)
  const midnight = now.getTime() - (((g("hour") % 24) * 3600 + g("minute") * 60 + g("second")) * 1000 + now.getMilliseconds())
  const H = 3600000, MIN = 60000
  let start = Math.floor((now.getTime() - 3 * H) / MIN) * MIN
  if (start < midnight + 5 * MIN) start = midnight - 4 * H
  const end = start + 2 * H
  const iso = (t) => new Date(t).toISOString()
  const hours = []
  for (let h = Math.floor(start / H) * H; h < end; h += H) {
    const ov = Math.min(end, h + H) - Math.max(start, h)
    if (ov > 0) hours.push({ hour_start: iso(h), app_id: "com.microsoft.VSCode", seconds: Math.round(ov / 1000) })
  }
  const body = {
    source: "mac", device: "smoke-suggest", window: { from: iso(Math.floor(start / H) * H), to: iso(Math.ceil(end / H) * H) }, hours,
    intervals: [{ start: iso(start), end: iso(end), top_app: "com.microsoft.VSCode" }],
    apps: [{ app_id: "com.microsoft.VSCode", label: "Visual Studio Code" }],
  }
  console.log(dayOf(now), dayOf(new Date(start)), iso(start), iso(end), iso(start + 45 * MIN), iso(start + 75 * MIN), JSON.stringify(body))
')
echo "== suggest smoke: VS Code block $START -> $END on $DAY (today $TODAY in $TZ_NAME)"

# 1. the Mac posts the block; the seeded app map already has VS Code as dev
check_js "screentime 2 h VS Code block (mac)" 200 'd.hours >= 2 && d.hours <= 3 && d.intervals === 1' -X POST -H "$MAC" -H "$J" -d "$BODY" "$BASE/api/screentime"

# 2. one suggestion covering exactly the block, VS Code on top, projects and last_project_id in the payload
ONE_EXPR="d.day === '$DAY' && d.suggestions.length === 1 && d.suggestions[0].start === '$START' && d.suggestions[0].end === '$END' && d.suggestions[0].minutes === 120
  && d.suggestions[0].top_apps.length === 1 && d.suggestions[0].top_apps[0].app_id === 'com.microsoft.VSCode' && d.suggestions[0].top_apps[0].label === 'Visual Studio Code' && d.suggestions[0].top_apps[0].minutes === 120
  && Array.isArray(d.projects) && 'last_project_id' in d"
check_js "suggestions: one 120 min block" 200 "$ONE_EXPR" -H "$APP" "$BASE/api/work/suggestions?day=$DAY"
if [ "$DAY" = "$TODAY" ]; then
  check_js "suggestions ?day=today is the same day" 200 "d.day === '$TODAY' && d.suggestions.length === 1 && d.suggestions[0].minutes === 120" -H "$APP" "$BASE/api/work/suggestions?day=today"
else
  check_js "suggestions ?day=today (block is on yesterday)" 200 "d.day === '$TODAY' && Array.isArray(d.suggestions)" -H "$APP" "$BASE/api/work/suggestions?day=today"
fi
check_js "suggestions without ?day defaults to today" 200 "d.day === '$TODAY'" -H "$APP" "$BASE/api/work/suggestions"

# 3. a session over the middle 30 min splits it into two 45 min suggestions; that session's project is the default
check_js "session over the middle 30 min" 201 "d.session.duration_s === 1800 && d.session.local_day === '$DAY' && d.created_project === true" \
  -X POST -H "$APP" -H "$J" -d "{\"project\":\"suggest-smoke\",\"start\":\"$MID_START\",\"end\":\"$MID_END\",\"day\":\"$DAY\"}" "$BASE/api/sessions"
SID="$(jsval 'd.session.id')"; PID="$(jsval 'd.project.id')"
check_js "suggestions: two 45 min blocks around it" 200 "d.suggestions.length === 2
  && d.suggestions[0].start === '$START' && d.suggestions[0].end === '$MID_START' && d.suggestions[0].minutes === 45 && d.suggestions[0].top_apps[0].minutes === 45
  && d.suggestions[1].start === '$MID_END' && d.suggestions[1].end === '$END' && d.suggestions[1].minutes === 45
  && d.last_project_id === '$PID' && d.projects.some((p) => p.id === '$PID' && p.name === 'suggest-smoke')" -H "$APP" "$BASE/api/work/suggestions?day=$DAY"

# 4. validation and roles
check_js "suggestions bad day" 400 "d.error === 'day must be YYYY-MM-DD'" -H "$APP" "$BASE/api/work/suggestions?day=2026-13-45"
check_js "suggestions date-ish garbage" 400 "d.error === 'day must be YYYY-MM-DD'" -H "$APP" "$BASE/api/work/suggestions?day=yesterday"
check_js "suggestions with shortcut token" 403 "d.error === 'forbidden'" -H "$SC" "$BASE/api/work/suggestions?day=$DAY"
check_js "suggestions with mac token" 403 "d.error === 'forbidden'" -H "$MAC" "$BASE/api/work/suggestions?day=$DAY"
check_js "suggestions wrong method" 405 "d.error === 'method not allowed'" -X POST -H "$APP" "$BASE/api/work/suggestions?day=$DAY"

# 5. tombstone the session the way the app would (outbox -> /api/write): the whole block is free again
NOW="$(node -e 'console.log(new Date().toISOString())')"
check_js "tombstone the session (app)" 200 'd.applied === 1 && d.rejected.length === 0' -X POST -H "$APP" -H "$J" \
  -d "{\"mutations\":[{\"table\":\"sessions\",\"rows\":[{\"id\":\"$SID\",\"project_id\":\"$PID\",\"started_at\":\"$MID_START\",\"ended_at\":\"$MID_END\",\"local_day\":\"$DAY\",\"duration_s\":1800,\"note\":null,\"source\":\"cli\",\"ended_by\":\"user\",\"created_at\":\"$NOW\",\"updated_at\":\"$NOW\",\"deleted_at\":\"$NOW\"}]}]}" "$BASE/api/write"
check_js "suggestions: the single block is back, no last project" 200 "$ONE_EXPR && d.last_project_id === null" -H "$APP" "$BASE/api/work/suggestions?day=$DAY"

[ "$FAIL" = 0 ] && echo "== suggest smoke passed" || { echo "== suggest smoke FAILED"; exit 1; }
