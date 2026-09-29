#!/usr/bin/env bash
# M4 lift smoke: run by scripts/smoke.sh against its wrangler dev server with BASE, APP_TOKEN, SHORTCUT_TOKEN,
# MAC_TOKEN and TZ_NAME exported. Logs a Push workout through POST /api/sets and reads it back through every route.
set -euo pipefail
: "${BASE:?BASE required}" "${APP_TOKEN:?APP_TOKEN required}" "${SHORTCUT_TOKEN:?SHORTCUT_TOKEN required}"

J='content-type: application/json'
APP="Authorization: Bearer $APP_TOKEN"; SC="Authorization: Bearer $SHORTCUT_TOKEN"
FAIL=0

# call <curl args...> -> sets STATUS and BODY
call() {
  local out
  out="$(curl -sS -o - -w $'\n%{http_code}' "$@")"
  STATUS="${out##*$'\n'}"; BODY="${out%$'\n'*}"
}
# js <expr over d> -> 0 when the parsed BODY satisfies it
js() {
  printf '%s' "$BODY" | EXPR="$1" node -e '
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      let ok = false
      try { ok = !!new Function("d", "return (" + process.env.EXPR + ")")(JSON.parse(s)) } catch (e) { console.error(String(e)) }
      process.exit(ok ? 0 : 1)
    })'
}
# field <js expr> -> prints the value
field() {
  printf '%s' "$BODY" | EXPR="$1" node -e '
    let s = ""
    process.stdin.on("data", (c) => (s += c)).on("end", () => { process.stdout.write(String(new Function("d", "return (" + process.env.EXPR + ")")(JSON.parse(s)))) })'
}
# check <name> <expected status> <js expr> <curl args...>
check() {
  local name="$1" want="$2" expr="$3"; shift 3
  call "$@"
  if [ "$STATUS" = "$want" ] && js "$expr"; then
    echo "ok   lift: $name -> $STATUS ${BODY:0:140}"
  else
    echo "FAIL lift: $name -> want $want and [$expr], got $STATUS ${BODY:0:600}"; FAIL=1
  fi
}

# 1. Log bench 3x8@135 into a new "Push" workout (finished at once: a CLI-logged past workout).
check "POST /api/sets new Push, bench 3x8@135" 201 'd.workout_id && d.exercise_id && d.set_ids.length === 3 && d.created.workout === true && d.created.exercise === true' \
  -X POST -H "$APP" -H "$J" -d '{"new_workout":{"name":"Push"},"exercise":"Bench press","reps":8,"weight":135,"count":3}' "$BASE/api/sets"
WID="$(field 'd.workout_id')"; EID="$(field 'd.exercise_id')"

# 2. A second call matches the exercise case-insensitively and continues set_no in the same workout.
check "POST /api/sets appends (case-insensitive exercise)" 201 "d.workout_id === '$WID' && d.exercise_id === '$EID' && d.created.exercise === false && d.set_ids.length === 1" \
  -X POST -H "$APP" -H "$J" -d "{\"workout_id\":\"$WID\",\"exercise\":\"  bench PRESS \",\"sets\":[{\"reps\":10,\"weight\":95,\"is_warmup\":true}]}" "$BASE/api/sets"

# 3. Lists and aggregates (the warm-up counts for neither sets_count nor volume).
check "GET /api/exercises" 200 "d.exercises.some((e) => e.id === '$EID' && e.name === 'Bench press' && e.use_count === 2 && e.weight_step === 5)" -H "$APP" "$BASE/api/exercises"
check "GET /api/workouts aggregates" 200 "d.workouts[0].id === '$WID' && d.workouts[0].name === 'Push' && d.workouts[0].sets_count === 3 && d.workouts[0].volume === 3240 && d.workouts[0].exercises_count === 1 && d.workouts[0].ended_at" -H "$APP" "$BASE/api/workouts?limit=5"
check "GET /api/workouts?before pages past it" 200 "!d.workouts.some((w) => w.id === '$WID')" -H "$APP" "$BASE/api/workouts?before=2000-01-01T00:00:00Z"
check "GET /api/workouts/:id with prior_best" 200 "d.workout.id === '$WID' && d.sets.length === 4 && d.exercises.length === 1 && d.sets[0].prior_best === null && d.sets[1].prior_best === 171 && d.sets[3].set_no === 4 && d.sets[3].is_warmup === 1" -H "$APP" "$BASE/api/workouts/$WID"
check "GET /api/lift/template?name=push" 200 "d.workout && d.workout.id === '$WID' && d.sets.length === 4 && d.exercises[0].id === '$EID'" -H "$APP" "$BASE/api/lift/template?name=push"
check "GET /api/lift/template unknown name" 200 'd.workout === null && d.sets.length === 0 && d.exercises.length === 0' -H "$APP" "$BASE/api/lift/template?name=Nope"
check "GET /api/exercises/:id/history" 200 "d.exercise.id === '$EID' && d.sessions.length === 1 && d.sessions[0].workout_id === '$WID' && d.sessions[0].best_e1rm === 171 && d.sessions[0].volume === 3240 && d.sessions[0].total_reps === 24 && d.sessions[0].is_pr === true && d.sessions[0].sets.length === 4 && d.sessions[0].top_set.weight === 135" -H "$APP" "$BASE/api/exercises/$EID/history?range=all"
check "GET history range=1m" 200 'd.range === "1m" && d.sessions.length === 1' -H "$APP" "$BASE/api/exercises/$EID/history?range=1m"
check "GET /api/lift/last-sets" 200 "d.sets.length === 3 && d.sets.every((s) => s.is_warmup === 0 && s.local_day && s.workout_name === 'Push') && d.best_e1rm === 171 && d.bests.length === 1 && d.bests[0].workout_id === '$WID' && d.bests[0].best === 171" -H "$APP" "$BASE/api/lift/last-sets?exercise_id=$EID"
check "GET /api/lift/last-sets excluding the workout" 200 'd.sets.length === 0 && d.best_e1rm === null && d.bests.length === 0' -H "$APP" "$BASE/api/lift/last-sets?exercise_id=$EID&exclude=$WID"

# 4. Errors and roles.
check "POST /api/sets empty body" 400 'd.error === "exercise (name or id) required"' -X POST -H "$APP" -H "$J" -d '{}' "$BASE/api/sets"
check "POST /api/sets unknown workout" 404 'd.error === "workout not found"' -X POST -H "$APP" -H "$J" -d '{"workout_id":"nope","exercise":"Bench press","reps":5}' "$BASE/api/sets"
check "GET /api/workouts/nope" 404 'd.error === "workout not found"' -H "$APP" "$BASE/api/workouts/nope"
check "GET history bad range" 400 'd.error.includes("range")' -H "$APP" "$BASE/api/exercises/$EID/history?range=2w"
check "GET history unknown exercise" 404 'd.error === "exercise not found"' -H "$APP" "$BASE/api/exercises/nope/history"
check "GET last-sets without exercise_id" 400 'd.error === "exercise_id required"' -H "$APP" "$BASE/api/lift/last-sets"
check "GET /api/exercises with shortcut token" 403 'd.error === "forbidden"' -H "$SC" "$BASE/api/exercises"
check "POST /api/sets with shortcut token" 403 'd.error === "forbidden"' -X POST -H "$SC" -H "$J" -d '{}' "$BASE/api/sets"

# 5. A second workout with the same exercise: bests[] ranks workouts by their best e1RM (140 x 8 = 177.3 beats 171)
#    and ?exclude drops one workout from sets, best_e1rm and bests alike.
check "POST /api/sets new Legs, bench 1x8@140" 201 "d.exercise_id === '$EID' && d.created.workout === true && d.created.exercise === false" \
  -X POST -H "$APP" -H "$J" -d '{"new_workout":{"name":"Legs"},"exercise":"Bench press","reps":8,"weight":140}' "$BASE/api/sets"
WID2="$(field 'd.workout_id')"
check "GET last-sets bests per workout" 200 "d.sets.length === 4 && d.best_e1rm === 177.3 && d.bests.length === 2 && d.bests[0].workout_id === '$WID2' && d.bests[0].best === 177.3 && d.bests[1].workout_id === '$WID' && d.bests[1].best === 171" \
  -H "$APP" "$BASE/api/lift/last-sets?exercise_id=$EID"
check "GET last-sets exclude keeps the other workout's best" 200 "d.sets.length === 3 && d.best_e1rm === 171 && d.bests.length === 1 && d.bests[0].workout_id === '$WID'" \
  -H "$APP" "$BASE/api/lift/last-sets?exercise_id=$EID&exclude=$WID2"

# 6. A tombstoned (merged-away) exercise: history answers 404 like the list hides it, so a stale link cannot edit it.
check "POST /api/sets creates a throwaway exercise" 201 "d.workout_id === '$WID2' && d.created.exercise === true && d.set_ids.length === 1" \
  -X POST -H "$APP" -H "$J" -d "{\"workout_id\":\"$WID2\",\"exercise\":\"Smoke merged away\",\"reps\":10,\"weight\":20}" "$BASE/api/sets"
EID2="$(field 'd.exercise_id')"
check "GET history of the throwaway exercise" 200 "d.exercise.id === '$EID2' && d.sessions.length === 1" -H "$APP" "$BASE/api/exercises/$EID2/history"
call -H "$APP" "$BASE/api/exercises"
LATER="$(node -e 'console.log(new Date(Date.now() + 60000).toISOString())')"
TOMB="$(field "JSON.stringify({ ...d.exercises.find((e) => e.id === '$EID2'), updated_at: '$LATER', deleted_at: '$LATER' })")"
check "write the exercise tombstone" 200 'd.applied === 1 && d.rejected.length === 0' -X POST -H "$APP" -H "$J" -d "{\"mutations\":[{\"table\":\"exercises\",\"rows\":[$TOMB]}]}" "$BASE/api/write"
check "GET history of a tombstoned exercise" 404 'd.error === "exercise not found"' -H "$APP" "$BASE/api/exercises/$EID2/history"
check "GET /api/exercises hides the tombstone" 200 "!d.exercises.some((e) => e.id === '$EID2') && d.exercises.some((e) => e.id === '$EID')" -H "$APP" "$BASE/api/exercises"

[ "$FAIL" = 0 ]
