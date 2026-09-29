#!/usr/bin/env bash
# M3 food smoke: run by scripts/smoke.sh against its wrangler dev server with BASE, APP_TOKEN, SHORTCUT_TOKEN, MAC_TOKEN
# and TZ_NAME exported. Exercises the two Claude Code helpers (POST /api/foods, POST /api/food-log), the three reads,
# and the role checks. The two USDA lookup routes only get a shape check (200 / 429 / 5xx) because the network may be
# unavailable; they never fail the smoke.
set -uo pipefail
: "${BASE:?BASE required}" "${APP_TOKEN:?APP_TOKEN required}" "${SHORTCUT_TOKEN:?SHORTCUT_TOKEN required}"
TZ_NAME="${TZ_NAME:-America/New_York}"

FAIL=0
J='content-type: application/json'
APP="Authorization: Bearer $APP_TOKEN"; SC="Authorization: Bearer $SHORTCUT_TOKEN"

# check_js <name> <expected status regex> <JS expression over the parsed body, bound to d> <curl args...>
check_js() {
  local name="$1" want="$2" expr="$3"; shift 3
  local out status body
  out="$(curl -sS -o - -w $'\n%{http_code}' "$@")"
  status="${out##*$'\n'}"; body="${out%$'\n'*}"
  if [[ "$status" =~ ^($want)$ ]] && printf '%s' "$body" | EXPR="$expr" node -e '
      let s = ""
      process.stdin.on("data", (c) => (s += c)).on("end", () => {
        let ok = false
        try { ok = !!new Function("d", "return (" + process.env.EXPR + ")")(JSON.parse(s)) } catch (e) { console.error(String(e)) }
        process.exit(ok ? 0 : 1)
      })'; then
    echo "ok   food: $name -> $status ${body:0:150}"
  else
    echo "FAIL food: $name -> want $want and [$expr], got $status ${body:0:600}"; FAIL=1
  fi
}
# json_field <body-file> <expr>
jsf() { EXPR="$2" node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const d=JSON.parse(s);process.stdout.write(String(new Function("d","return ("+process.env.EXPR+")")(d)))})' < "$1"; }

TODAY="$(TZ_NAME="$TZ_NAME" node -e 'const p=new Intl.DateTimeFormat("en-CA",{timeZone:process.env.TZ_NAME,year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());console.log(p)')"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
STAMP="$(date +%s)"
NAME="Smoke yogurt $STAMP"

# --- POST /api/foods: per-serving -> per-100 g, consistent label -> no warning
check_js "add food per serving" 201 "d.food.name === '$NAME' && d.food.source === 'claude' && d.food.kcal_100 === 97.1 && d.food.protein_100 === 10 && d.food.carb_100 === 3.5 && d.food.fat_100 === 5.3 && d.food.fiber_100 === null && d.food.serving_g === 170 && d.food.use_count === 0 && Array.isArray(d.warnings) && d.warnings.length === 0" \
  -X POST -H "$APP" -H "$J" -d "{\"name\":\"$NAME\",\"brand\":\"Smoke\",\"serving_g\":170,\"serving_text\":\"3/4 cup (170 g)\",\"per_serving\":{\"kcal\":165,\"protein_g\":17,\"carb_g\":6,\"fat_g\":9,\"sugar_g\":6},\"label_json\":{\"kcal\":165}}" "$BASE/api/foods"
# inconsistent label -> 201 with a 4/4/9 warning
check_js "add food flags 4/4/9" 201 "d.food.kcal_100 === 200 && d.warnings.length === 1 && /imply 290 kcal/.test(d.warnings[0])" \
  -X POST -H "$APP" -H "$J" -d "{\"name\":\"Smoke bar $STAMP\",\"serving_g\":50,\"per_serving\":{\"kcal\":100,\"protein_g\":20,\"carb_g\":30,\"fat_g\":10}}" "$BASE/api/foods"
check_js "add food per100 direct" 201 "d.food.source === 'usda' && d.food.source_id === '169756' && d.food.kcal_100 === 130" \
  -X POST -H "$APP" -H "$J" -d "{\"name\":\"Smoke rice $STAMP\",\"source\":\"usda\",\"source_id\":169756,\"per100\":{\"kcal_100\":130,\"protein_100\":2.7,\"carb_100\":28,\"fat_100\":0.3}}" "$BASE/api/foods"
check_js "add food missing numbers" 400 "d.error === 'per_serving (with serving_g) or per100 required'" -X POST -H "$APP" -H "$J" -d '{"name":"x"}' "$BASE/api/foods"
check_js "add food per_serving without serving_g" 400 "d.error === 'serving_g is required with per_serving'" -X POST -H "$APP" -H "$J" -d '{"name":"x","per_serving":{"kcal":1,"protein_g":0,"carb_g":0,"fat_g":0}}' "$BASE/api/foods"
check_js "add food with shortcut token" 403 "d.error === 'forbidden'" -X POST -H "$SC" -H "$J" -d '{"name":"x"}' "$BASE/api/foods"

# --- POST /api/food-log by name with grams -> snapshot kcal = 97.1 * 1.8 = 174.8, slot from the local hour or as given
curl -sS -o "$TMP/log.json" -w '' -X POST -H "$APP" -H "$J" -d "{\"food_name\":\"$NAME\",\"grams\":180,\"slot\":\"breakfast\",\"note\":\"smoke\"}" "$BASE/api/food-log"
check_js "log food by name" 201 "d.entry.food_id && d.entry.grams === 180 && d.entry.kcal === 174.8 && d.entry.protein_g === 18 && d.entry.slot === 'breakfast' && d.entry.local_day === '$TODAY' && d.entry.source === 'cli' && d.entry.label === '$NAME' && d.entry.note === 'smoke'" \
  -X POST -H "$APP" -H "$J" -d "{\"food_name\":\"$NAME\",\"grams\":180,\"slot\":\"breakfast\",\"note\":\"smoke\"}" "$BASE/api/food-log"
check_js "log food at HH:MM infers the slot" 201 "d.entry.slot === 'dinner' && d.entry.kcal === 97.1 && d.entry.local_day === '$TODAY' && /T/.test(d.entry.ts)" \
  -X POST -H "$APP" -H "$J" -d "{\"food_name\":\"$NAME\",\"grams\":100,\"at\":\"19:00\"}" "$BASE/api/food-log"
check_js "log ambiguous name" 400 "/ambiguous/.test(d.error) && Array.isArray(d.candidates)" -X POST -H "$APP" -H "$J" -d "{\"food_name\":\"Smoke\",\"grams\":10}" "$BASE/api/food-log"
check_js "log unknown name" 400 "d.error === 'no food matches \"nothing-like-this\"'" -X POST -H "$APP" -H "$J" -d '{"food_name":"nothing-like-this","grams":10}' "$BASE/api/food-log"
check_js "log food without grams" 400 "d.error === 'grams (> 0) required for a food'" -X POST -H "$APP" -H "$J" -d "{\"food_name\":\"$NAME\"}" "$BASE/api/food-log"
check_js "log with two targets" 400 "/exactly one of/.test(d.error)" -X POST -H "$APP" -H "$J" -d '{"food_id":"a","meal_id":"b","grams":1}' "$BASE/api/food-log"
check_js "log unknown meal id" 400 "d.error === 'no meal with id nope'" -X POST -H "$APP" -H "$J" -d '{"meal_id":"nope"}' "$BASE/api/food-log"

# --- reads
check_js "food log today totals" 200 "d.day === '$TODAY' && d.entries.filter((e) => e.label === '$NAME').length === 3 && d.totals.kcal >= 446.7 && d.by_slot.breakfast && d.by_slot.breakfast.kcal >= 174.8 && d.by_slot.dinner && d.by_slot.dinner.kcal >= 97.1 && d.totals.fiber_g === null" -H "$APP" "$BASE/api/food-log?day=today"
check_js "food log explicit day" 200 "d.day === '2026-01-02' && d.entries.length === 0 && d.totals.kcal === 0 && Object.keys(d.by_slot).length === 0" -H "$APP" "$BASE/api/food-log?day=2026-01-02"
check_js "food log bad day" 400 "d.error === 'day must be YYYY-MM-DD or today'" -H "$APP" "$BASE/api/food-log?day=2026-13-45"
check_js "foods search finds it with use_count bumped" 200 "d.foods.length === 1 && d.foods[0].name === '$NAME' && d.foods[0].use_count === 3 && d.foods[0].last_used_at" -H "$APP" "$BASE/api/foods?q=yogurt%20$STAMP"

# --- POST /api/foods with the id of an existing food (the documented correction path) rewrites the numbers but keeps
# use_count / last_used_at / created_at, so the food stays where it was in the most-used ordering
FOOD_ID="$(jsf "$TMP/log.json" 'd.entry.food_id')"
curl -sS -o "$TMP/food.json" -w '' -H "$APP" "$BASE/api/foods?q=yogurt%20$STAMP"
CREATED="$(jsf "$TMP/food.json" 'd.foods[0].created_at')"
check_js "re-add food by id keeps use_count and created_at" 201 "d.food.id === '$FOOD_ID' && d.food.brand === 'Smoke v2' && d.food.fiber_100 === 1 && d.food.kcal_100 === 97.1 && d.food.use_count === 3 && typeof d.food.last_used_at === 'string' && d.food.created_at === '$CREATED' && d.food.updated_at > '$CREATED' && d.warnings.length === 0" \
  -X POST -H "$APP" -H "$J" -d "{\"id\":\"$FOOD_ID\",\"name\":\"$NAME\",\"brand\":\"Smoke v2\",\"serving_g\":170,\"per100\":{\"kcal_100\":97.1,\"protein_100\":10,\"carb_100\":3.5,\"fat_100\":5.3,\"fiber_100\":1,\"sugar_100\":3.5}}" "$BASE/api/foods"
check_js "foods search still ranks it first after the correction" 200 "d.foods.length === 1 && d.foods[0].brand === 'Smoke v2' && d.foods[0].use_count === 3 && d.foods[0].created_at === '$CREATED'" -H "$APP" "$BASE/api/foods?q=yogurt%20$STAMP"
check_js "add food with a new explicit id starts unused" 201 "d.food.id === 'smoke-food-$STAMP' && d.food.use_count === 0 && d.food.last_used_at === null && typeof d.food.created_at === 'string' && d.food.created_at === d.food.updated_at" \
  -X POST -H "$APP" -H "$J" -d "{\"id\":\"smoke-food-$STAMP\",\"name\":\"Smoke explicit $STAMP\",\"per100\":{\"kcal_100\":50,\"protein_100\":1,\"carb_100\":10,\"fat_100\":0.5}}" "$BASE/api/foods"
check_js "foods search by brand, most used first" 200 "d.foods.length >= 2 && d.foods[0].name === '$NAME' && d.foods.every((f) => f.deleted_at === null)" -H "$APP" "$BASE/api/foods?q=smoke"
check_js "foods LIKE wildcards are literal" 200 "d.foods.length === 0" -H "$APP" "$BASE/api/foods?q=%25%25%25"
check_js "foods limit" 200 "d.foods.length === 1" -H "$APP" "$BASE/api/foods?limit=1"
check_js "meals" 200 "Array.isArray(d.meals) && Array.isArray(d.items)" -H "$APP" "$BASE/api/meals"
check_js "foods with shortcut token" 403 "d.error === 'forbidden'" -H "$SC" "$BASE/api/foods"
check_js "food log wrong method" 405 "d.error === 'method not allowed'" -X PUT -H "$APP" "$BASE/api/food-log"

# --- a meal written through /api/write, then logged by name through the helper (snapshot = totals x scale)
NOW="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
MEAL_ID="smoke-meal-$STAMP"
check_js "write meal + item" 200 "d.applied === 2 && d.rejected.length === 0" -X POST -H "$APP" -H "$J" -d "{\"mutations\":[{\"table\":\"meals\",\"rows\":[{\"id\":\"$MEAL_ID\",\"name\":\"Smoke bowl $STAMP\",\"total_g\":200,\"kcal\":194.2,\"protein_g\":20,\"carb_g\":7,\"fat_g\":10.6,\"fiber_g\":null,\"sugar_g\":7,\"default_slot\":\"breakfast\",\"use_count\":0,\"last_used_at\":null,\"created_at\":\"$NOW\",\"updated_at\":\"$NOW\",\"deleted_at\":null}]},{\"table\":\"meal_items\",\"rows\":[{\"id\":\"smoke-item-$STAMP\",\"meal_id\":\"$MEAL_ID\",\"food_id\":\"$FOOD_ID\",\"grams\":200,\"position\":0,\"updated_at\":\"$NOW\",\"deleted_at\":null}]}]}" "$BASE/api/write"
check_js "log meal by name x1.5" 201 "d.entry.meal_id === '$MEAL_ID' && d.entry.scale === 1.5 && d.entry.grams === null && d.entry.kcal === 291.3 && d.entry.protein_g === 30 && d.entry.fiber_g === null && d.entry.sugar_g === 10.5" \
  -X POST -H "$APP" -H "$J" -d "{\"meal_name\":\"Smoke bowl $STAMP\",\"scale\":1.5}" "$BASE/api/food-log"
check_js "meals lists it with its item and use_count 1" 200 "d.meals.some((m) => m.id === '$MEAL_ID' && m.use_count === 1) && d.items.some((i) => i.meal_id === '$MEAL_ID' && i.food_id === '$FOOD_ID')" -H "$APP" "$BASE/api/meals"

# --- lookups: shape only (network may be missing; DEMO_KEY may be rate-limited)
check_js "lookup search shape" '200|429|5[0-9][0-9]' "(Array.isArray(d.candidates) && d.candidates.every((c) => typeof c.kcal_100 === 'number' && c.source === 'usda')) || typeof d.error === 'string'" -H "$APP" "$BASE/api/lookup/search?q=oats&type=generic"
check_js "lookup search needs q" 400 "d.error === 'q required'" -H "$APP" "$BASE/api/lookup/search"
check_js "lookup search bad type" 400 "d.error === 'type must be generic or branded'" -H "$APP" "$BASE/api/lookup/search?q=x&type=nope"
check_js "lookup barcode shape" '200|429|5[0-9][0-9]' "('candidate' in d && (d.candidate === null || d.candidate.source === 'usda')) || typeof d.error === 'string'" -H "$APP" "$BASE/api/lookup/barcode/0016000275270"
check_js "lookup barcode bad code" 400 "d.error === 'code must be 8-14 digits'" -H "$APP" "$BASE/api/lookup/barcode/12"
check_js "lookup with shortcut token" 403 "d.error === 'forbidden'" -H "$SC" "$BASE/api/lookup/search?q=oats"

exit "$FAIL"
