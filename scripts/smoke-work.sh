#!/usr/bin/env bash
# Work (milestone 5) smoke checks. Run by scripts/smoke.sh against its wrangler dev server with BASE, APP_TOKEN,
# SHORTCUT_TOKEN, MAC_TOKEN and TZ_NAME exported; exit 0 = every check passed.
set -euo pipefail
: "${BASE:?BASE required}" "${APP_TOKEN:?APP_TOKEN required}" "${SHORTCUT_TOKEN:?SHORTCUT_TOKEN required}" "${TZ_NAME:?TZ_NAME required}"

J='content-type: application/json'
APP="Authorization: Bearer $APP_TOKEN"; SC="Authorization: Bearer $SHORTCUT_TOKEN"
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
    echo "ok   work: $name -> $status ${body:0:160}"
  else
    echo "FAIL work: $name -> want $want and [$expr], got $status ${body:0:600}"; FAIL=1
  fi
}
# jsval <JS expression over the parsed LAST_BODY> -> prints the value
jsval() {
  printf '%s' "$LAST_BODY" | EXPR="$1" node -e '
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => { process.stdout.write(String(new Function("d", "return (" + process.env.EXPR + ")")(JSON.parse(s)))) })'
}

TODAY="$(TZ_NAME="$TZ_NAME" node -e 'console.log(new Intl.DateTimeFormat("en-CA", { timeZone: process.env.TZ_NAME, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()))')"
echo "== work smoke (today $TODAY in $TZ_NAME)"

# 1. the Claude Code helper: 90 min on 'planner' (unknown -> created), ended now, local_day today
check_js "session add (minutes)" 201 "d.session.local_day === '$TODAY' && d.session.duration_s === 5400 && d.session.note === 'wrote the sync layer' && d.session.source === 'cli' && d.created_project === true && d.session.project_name === 'planner'" \
  -X POST -H "$APP" -H "$J" -d '{"project":"planner","minutes":90,"note":"wrote the sync layer"}' "$BASE/api/sessions"
PID="$(jsval 'd.project.id')"

# 2. projects list has it
check_js "projects include planner" 200 "d.projects.some((p) => p.id === '$PID' && p.name === 'planner' && p.archived_at === null)" -H "$APP" "$BASE/api/projects"

# 3. today's range sums 5400 for it (SQL sums, running excluded)
check_js "sessions today sums" 200 "d.from === '$TODAY' && d.to === '$TODAY' && d.by_project['$PID'] === 5400 && d.by_day['$TODAY'] === 5400 && d.sessions.length === 1 && d.sessions[0].project_name === 'planner'" \
  -H "$APP" "$BASE/api/sessions?from=$TODAY&to=$TODAY"
check_js "sessions accept from=today" 200 "d.from === '$TODAY' && d.by_project['$PID'] === 5400" -H "$APP" "$BASE/api/sessions?from=today"

# 4. the changelog has the note
check_js "project log has the note" 200 "d.project.id === '$PID' && d.entries.length === 1 && d.entries[0].note === 'wrote the sync layer' && d.entries[0].duration_s === 5400 && d.total_s === 5400 && d.count === 1" \
  -H "$APP" "$BASE/api/projects/$PID/log?limit=10"
check_js "project log 404 for unknown" 404 "d.error === 'project not found'" -H "$APP" "$BASE/api/projects/nope/log"

# 5. time blocks with local HH:MM (a study block names the project case-insensitively)
check_js "time-blocks (local HH:MM)" 201 "d.ids.length === 2 && d.day === '$TODAY' && d.blocks[1].project_id === '$PID' && d.blocks[0].category === 'meal' && d.blocks[0].label === 'Lunch' && d.created_projects.length === 0 && new Date(d.blocks[0].end_ts) - new Date(d.blocks[0].start_ts) === 40 * 60000" \
  -X POST -H "$APP" -H "$J" -d '{"blocks":[{"start":"12:00","end":"12:40","category":"meal","label":"Lunch"},{"start":"09:00","end":"09:30","category":"study","project":"PLANNER"}]}' "$BASE/api/time-blocks"
check_js "time-blocks bad category" 400 "/blocks\[0\].category/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"blocks":[{"start":"12:00","end":"12:40","category":"gaming"}]}' "$BASE/api/time-blocks"
check_js "time-blocks end before start" 400 "/end must be after start/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"blocks":[{"start":"2026-09-28T10:00:00Z","end":"2026-09-28T09:00:00Z","category":"rest"}]}' "$BASE/api/time-blocks"

# 6. the week has 7 days each, today carrying the 5400 s
check_js "work week" 200 "d.days.length === 7 && d.last_week.days.length === 7 && d.days.some((x) => x.local_day === '$TODAY' && x.seconds === 5400 && x.by_project['$PID'] === 5400) && d.days[0].local_day === d.week_start && d.projects.some((p) => p.id === '$PID')" \
  -H "$APP" "$BASE/api/work/week?day=$TODAY"
check_js "work week bad day" 400 "d.error === 'day must be YYYY-MM-DD'" -H "$APP" "$BASE/api/work/week?day=2026-13-45"

# 7. a second session by name (case-insensitive) with local start/end on a past day joins the same project
check_js "session add (start/end, past day)" 201 "d.created_project === false && d.project.id === '$PID' && d.session.local_day === '2026-01-05' && d.session.duration_s === 2700" \
  -X POST -H "$APP" -H "$J" -d '{"project":"Planner","start":"07:00","end":"07:45","day":"2026-01-05"}' "$BASE/api/sessions"
check_js "project log newest first" 200 "d.entries.length === 2 && d.entries[0].local_day === '$TODAY' && d.entries[1].local_day === '2026-01-05' && d.total_s === 8100" -H "$APP" "$BASE/api/projects/$PID/log"
check_js "sessions range covers both" 200 "d.by_project['$PID'] === 8100 && Object.keys(d.by_day).length === 2" -H "$APP" "$BASE/api/sessions?from=2026-01-01&to=$TODAY"

# 8. validation and roles
check_js "session add without project" 400 "/project/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"minutes":10}' "$BASE/api/sessions"
check_js "session add without a span" 400 "/minutes or start\+end/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"project":"planner"}' "$BASE/api/sessions"
check_js "session add bad minutes" 400 "/minutes/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"project":"planner","minutes":0}' "$BASE/api/sessions"
#    start/end take a zoned ISO instant or a local HH:MM only. `new Date()` alone would read these as 2001-12-01,
#    UTC midnight, the Worker's UTC (twice) and a rolled-over March 2nd: a typo must not land a session on another day.
check_js "session add bare-hour start" 400 "/^start must be a zoned ISO timestamp/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"project":"planner","start":"12","minutes":30}' "$BASE/api/sessions"
check_js "session add date-only start" 400 "/^start must be a zoned ISO timestamp/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"project":"planner","start":"2026-09-28","minutes":30}' "$BASE/api/sessions"
check_js "session add legacy date start" 400 "/^start must be a zoned ISO timestamp/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"project":"planner","start":"Sep 28 2026 10:00","end":"Sep 28 2026 11:00"}' "$BASE/api/sessions"
check_js "session add zone-less ISO start" 400 "/^start must be a zoned ISO timestamp/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"project":"planner","start":"2026-09-28T10:00","minutes":30}' "$BASE/api/sessions"
check_js "time-blocks impossible date" 400 "/^blocks\\[0\\]\\.end must be a zoned ISO timestamp/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"blocks":[{"start":"10:00","end":"2026-02-30T11:00:00Z","category":"rest"}]}' "$BASE/api/time-blocks"
check_js "session add zoned ISO with offset" 201 "d.session.started_at === '2026-01-05T11:00:00.000Z' && d.session.duration_s === 1800 && d.session.local_day === '2026-01-05'" -X POST -H "$APP" -H "$J" -d '{"project":"planner","start":"2026-01-05T06:00:00-05:00","minutes":30,"day":"2026-01-05"}' "$BASE/api/sessions"
check_js "rejected inputs logged nothing" 200 "d.entries.length === 3 && d.total_s === 9900" -H "$APP" "$BASE/api/projects/$PID/log"
check_js "sessions bad range" 400 "d.error === 'to must be on or after from'" -H "$APP" "$BASE/api/sessions?from=$TODAY&to=2026-01-01"
check_js "session add with shortcut token" 403 "d.error === 'forbidden'" -X POST -H "$SC" -H "$J" -d '{"project":"planner","minutes":10}' "$BASE/api/sessions"
check_js "projects with shortcut token" 403 "d.error === 'forbidden'" -H "$SC" "$BASE/api/projects"
check_js "projects wrong method" 405 "d.error === 'method not allowed'" -X DELETE -H "$APP" "$BASE/api/projects"

# 9. the day chart draws the session as study. The span never starts before local midnight (the clamp), but right
#    after midnight most of it is still in the future and buildDay clips to now, so only ask for some seconds.
check_js "day today shows the study block" 200 "d.study_by_project['$PID'] > 0 && d.blocks.some((b) => b.category === 'study' && b.label === 'planner' && b.source === 'session')" -H "$APP" "$BASE/api/day/today"

[ "$FAIL" = 0 ]
