#!/usr/bin/env bash
# M7 smoke: rollups, /api/summary, the cron, /api/export, the write -> waitUntil rebuild, and the CLI commands.
# Run by scripts/smoke.sh against its server with BASE, APP_TOKEN, SHORTCUT_TOKEN, MAC_TOKEN and TZ_NAME exported.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
: "${BASE:?BASE required}" "${APP_TOKEN:?APP_TOKEN required}" "${SHORTCUT_TOKEN:?SHORTCUT_TOKEN required}" "${TZ_NAME:=America/New_York}"

FAIL=0
check() {
  local name="$1" want="$2" pat="$3"; shift 3
  local out status body
  out="$(curl -sS -o - -w $'\n%{http_code}' "$@")"
  status="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [ "$status" = "$want" ] && printf '%s' "$body" | grep -Eq -- "$pat"; then
    echo "ok   $name -> $status ${body:0:160}"
  else
    echo "FAIL $name -> want $want /$pat/, got $status ${body:0:400}"; FAIL=1
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
J='content-type: application/json'
APP="Authorization: Bearer $APP_TOKEN"; SC="Authorization: Bearer $SHORTCUT_TOKEN"

# The server's local today, and the instants we seed yesterday with (07:00 local for the tap, 12:00-13:00 and
# 14:00-15:00 local for the manual blocks), computed with the same Intl algorithm as src/shared/tz.ts.
TODAY="$(curl -sS -H "$APP" "$BASE/api/me" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).today))')"
read -r YESTERDAY WEEK_AGO TOMORROW TAP_TS B1_START B1_END B2_START B2_END NOW < <(TODAY="$TODAY" TZ_NAME="$TZ_NAME" node -e '
  const tz = process.env.TZ_NAME, today = process.env.TODAY
  const pad = (n) => String(n).padStart(2, "0")
  const shift = (day, n) => { const [y, m, d] = day.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}` }
  const off = (date) => { const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date); const g = (t) => Number(p.find((x) => x.type === t).value); const h = g("hour") === 24 ? 0 : g("hour"); return Date.UTC(g("year"), g("month") - 1, g("day"), h, g("minute"), g("second")) - Math.floor(date.getTime() / 1000) * 1000 }
  const zoned = (day, h) => { const [y, m, d] = day.split("-").map(Number); const guess = Date.UTC(y, m - 1, d, h); let o = off(new Date(guess)); let inst = guess - o; const o2 = off(new Date(inst)); if (o2 !== o) inst = guess - o2; return new Date(inst).toISOString() }
  const y = shift(today, -1)
  console.log(y, shift(today, -7), shift(today, 1), zoned(y, 7), zoned(y, 12), zoned(y, 13), zoned(y, 14), zoned(y, 15), new Date().toISOString())
')
echo "== rollup smoke: today $TODAY, yesterday $YESTERDAY (tz $TZ_NAME)"

# ---- seed yesterday: one routine tap (default 10 min for stretch) + one manual block (12:00-13:00)
check "tap stretch yesterday (app, back-dated)" 200 '"action":"routine_started"' -X POST -H "$APP" -H "$J" -d "{\"item\":\"stretch\",\"ts\":\"$TAP_TS\"}" "$BASE/api/tap"
# A routine row eight days ago (just outside the checked range) makes every day in the range "in scope" for the
# first-data-day cutoff without pre-building any of the checked days.
EIGHT_AGO="$(node -e 'const [y,m,d]=process.argv[1].split("-").map(Number);console.log(new Date(Date.UTC(y,m-1,d-1)).toISOString().slice(0,10))' "$WEEK_AGO")"
check "write routine row eight days ago (app)" 200 '"applied":1' -X POST -H "$APP" -H "$J" \
  -d "{\"mutations\":[{\"table\":\"routine_log\",\"rows\":[{\"local_day\":\"$EIGHT_AGO\",\"item_id\":\"journal\",\"started_at\":\"${EIGHT_AGO}T12:00:00.000Z\",\"ended_at\":null,\"source\":\"app\",\"updated_at\":\"$NOW\",\"deleted_at\":null}]}]}" "$BASE/api/write"
check "write block yesterday 12-13 (app)" 200 '"applied":1,"rejected":\[\]' -X POST -H "$APP" -H "$J" \
  -d "{\"mutations\":[{\"table\":\"time_blocks\",\"rows\":[{\"id\":\"smoke-b1\",\"start_ts\":\"$B1_START\",\"end_ts\":\"$B1_END\",\"category\":\"meal\",\"label\":\"Lunch\",\"source\":\"app\",\"created_at\":\"$NOW\",\"updated_at\":\"$NOW\"}]}]}" "$BASE/api/write"

# ---- POST /api/rollup: routine + manual minutes, the rest unknown, not final yet (yesterday)
ROLLUP_EXPR="d.day === '$YESTERDAY' && d.summary.local_day === '$YESTERDAY'
  && d.summary.routine_s === 600 && d.summary.manual_s === 3600 && d.summary.manual_by_category.meal === 3600
  && [82800, 86400, 90000].includes(d.summary.tracked_s)
  && d.summary.unknown_s === d.summary.tracked_s - (d.summary.sleep_s + d.summary.workout_s + d.summary.study_s + d.summary.routine_s + d.summary.mac_s + d.summary.phone_s + d.summary.manual_s)
  && d.summary.routine_done === 1 && d.summary.routine_total >= 5 && d.summary.kcal === null && d.summary.sets_count === 0 && d.summary.final === 0 && typeof d.summary.computed_at === 'string'"
check_js "rollup yesterday (app)"         200 "$ROLLUP_EXPR" -X POST -H "$APP" -H "$J" -d "{\"day\":\"$YESTERDAY\"}" "$BASE/api/rollup"
check_js "rollup 'yesterday' keyword"     200 "d.day === '$YESTERDAY'" -X POST -H "$APP" -H "$J" -d '{"day":"yesterday"}' "$BASE/api/rollup"
check "rollup future day"                 400 '"error":"day is in the future"' -X POST -H "$APP" -H "$J" -d "{\"day\":\"$TOMORROW\"}" "$BASE/api/rollup"
check "rollup bad day"                    400 '"error":"day must be YYYY-MM-DD, today or yesterday"' -X POST -H "$APP" -H "$J" -d '{"day":"nope"}' "$BASE/api/rollup"
check "rollup with shortcut token"        403 '"error":"forbidden"' -X POST -H "$SC" -H "$J" -d '{"day":"2026-01-01"}' "$BASE/api/rollup"

# ---- GET /api/summary: 8 days, today live, at most 3 recomputed per request (oldest first), missing days beyond
# the cap flagged stale; yesterday's fresh non-final row is served as it is (D-2 may already be final from the cron).
SUMMARY_EXPR="d.from === '$WEEK_AGO' && d.to === '$TODAY' && d.today === '$TODAY' && d.days.length === 8 && Array.isArray(d.projects)
  && d.days[7].local_day === '$TODAY' && d.days[7].live === true && !d.days[7].stale && d.days[7].tracked_s >= 0
  && d.days[6].local_day === '$YESTERDAY' && d.days[6].manual_s === 3600 && d.days[6].routine_s === 600
  && d.days.slice(0, 3).every((x) => x.stale === undefined && typeof x.computed_at === 'string' && x.final === 1)
  && d.days[3].stale === true && d.days[3].computed_at === null && d.days[4].stale === true
  && (d.days[5].final === 1 || d.days[5].stale === true)
  && d.days[6].stale === undefined && d.days[6].final === 0"
check_js "summary week (app)"             200 "$SUMMARY_EXPR" -H "$APP" "$BASE/api/summary?from=$WEEK_AGO&to=$TODAY"
check "summary > 62 days"                 400 '"error":"at most 62 days per request"' -H "$APP" "$BASE/api/summary?from=2026-01-01&to=2026-03-31"
check "summary from after to"             400 '"error":"from must not be after to"' -H "$APP" "$BASE/api/summary?from=2026-02-01&to=2026-01-01"
check "summary bad dates"                 400 '"error":"from and to must be YYYY-MM-DD' -H "$APP" "$BASE/api/summary?from=x&to=y"
check "summary with shortcut token"       403 '"error":"forbidden"' -H "$SC" "$BASE/api/summary?from=$WEEK_AGO&to=$TODAY"
check_js "summary ending before today has no live day" 200 "d.days.length === 2 && d.days.every((x) => !x.live)" -H "$APP" "$BASE/api/summary?from=2026-01-01&to=2026-01-02"

# ---- POST /api/cron/run: rebuilds D-1 and D-2, drains dirty days, finalises, prunes
check_js "cron run (app)"                 200 "d.ok === true && Array.isArray(d.ran) && d.ran.length >= 4 && d.rebuilt.includes('$YESTERDAY') && d.today === '$TODAY' && typeof d.auto_closed.workouts === 'number'" -X POST -H "$APP" "$BASE/api/cron/run"
check "cron health row updated"           200 '"source":"cron","last_ok_at":"20[^"]*","last_error_at":null,"last_error":null,"detail":"rebuilt' -H "$APP" "$BASE/api/health/automations"
check_js "summary after cron: nothing stale" 200 "d.days.length === 8 && d.days.every((x) => !x.stale) && d.days[7].live === true" -H "$APP" "$BASE/api/summary?from=$WEEK_AGO&to=$TODAY"

# ---- GET /api/export: every table, day_summary has yesterday
EXPORT_EXPR="typeof d.exported_at === 'string' && d.row_cap === 20000 && Array.isArray(d.truncated) && d.truncated.length === 0
  && Object.keys(d.tables).length === 22 && d.counts.day_summary >= 1 && Array.isArray(d.tables.tap_log) && Array.isArray(d.tables.settings) && d.tables.settings.length >= 6
  && d.tables.day_summary.some((r) => r.local_day === '$YESTERDAY' && r.manual_s === 3600 && typeof r.manual_by_category === 'string')"
check_js "export (app)"                   200 "$EXPORT_EXPR" -H "$APP" "$BASE/api/export"
check "export with shortcut token"        403 '"error":"forbidden"' -H "$SC" "$BASE/api/export"

# ---- a write touching yesterday rebuilds its summary in the background (ctx.waitUntil), clearing dirty_days
check "write block yesterday 14-15 (app)" 200 '"applied":1,"rejected":\[\]' -X POST -H "$APP" -H "$J" \
  -d "{\"mutations\":[{\"table\":\"time_blocks\",\"rows\":[{\"id\":\"smoke-b2\",\"start_ts\":\"$B2_START\",\"end_ts\":\"$B2_END\",\"category\":\"chores\",\"label\":\"Laundry\",\"source\":\"app\",\"created_at\":\"$NOW\",\"updated_at\":\"$NOW\"}]}]}" "$BASE/api/write"
sleep 2
# export reads the tables as they are (no recompute), so this is the waitUntil rebuild, not /api/summary's.
check_js "export shows the rebuilt row"   200 "d.tables.day_summary.some((r) => r.local_day === '$YESTERDAY' && r.manual_s === 7200 && JSON.parse(r.manual_by_category).chores === 3600) && !d.tables.dirty_days.some((r) => r.local_day === '$YESTERDAY')" -H "$APP" "$BASE/api/export"
check_js "summary shows the new total"    200 "d.days.find((x) => x.local_day === '$YESTERDAY').manual_s === 7200" -H "$APP" "$BASE/api/summary?from=$YESTERDAY&to=$YESTERDAY"

# ---- CLI (bin/planner) against the same server; the token travels in the environment, never on a command line
CLI_TMP="$(mktemp -d)"
if OUT="$(PLANNER_URL="$BASE" PLANNER_TOKEN="$APP_TOKEN" node bin/planner rollup yesterday 2>&1)" && printf '%s' "$OUT" | grep -q "Rebuilt $YESTERDAY" && printf '%s' "$OUT" | grep -Eq 'manual +2h 00m'; then
  echo "ok   planner rollup yesterday"
else
  echo "FAIL planner rollup yesterday: $OUT"; FAIL=1
fi
if OUT="$(PLANNER_URL="$BASE" PLANNER_TOKEN="$APP_TOKEN" node bin/planner export --out "$CLI_TMP/export.json" 2>&1)" && [ -s "$CLI_TMP/export.json" ] && node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.exit(d.tables && d.tables.day_summary && d.counts ? 0 : 1)' "$CLI_TMP/export.json" && printf '%s' "$OUT" | grep -q "day_summary"; then
  echo "ok   planner export --out"
else
  echo "FAIL planner export: $OUT"; FAIL=1
fi
if OUT="$(node bin/planner screentime phone --day "$YESTERDAY" --hours '{"7":12,"8":45}' --tz "$TZ_NAME" --dry-run 2>/dev/null)" && printf '%s' "$OUT" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const b=JSON.parse(s);process.exit(b.source==="phone"&&b.device==="iPhone"&&b.hours.length===2&&b.hours[0].app_id==="_total"&&b.hours[0].seconds===720&&b.hours[1].seconds===2700&&b.window.from<b.hours[0].hour_start&&b.hours[1].hour_start<b.window.to?0:1)})'; then
  echo "ok   planner screentime phone --dry-run"
else
  echo "FAIL planner screentime phone --dry-run: $OUT"; FAIL=1
fi
rm -rf "$CLI_TMP"

if [ "$FAIL" = 0 ]; then echo "== rollup smoke passed"; else echo "== rollup smoke FAILED"; exit 1; fi
