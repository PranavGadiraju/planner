

####################################################################################################
# DESIGN: SIMPLICITY — fewest moving parts, one repo, one Worker, one D1 database, eight t
####################################################################################################

## OVERVIEW
The app is a single installable PWA served by one Cloudflare Worker (free plan) that also exposes ~16 JSON routes under /api/* backed by D1; the same Worker has one Cron Trigger that freezes finished days into a `days` rollup table. The server is the source of truth for "what day is it" (env.TZ) and for all idempotency (client-generated UUIDs or natural keys such as (day,item) and (device,hour,app)), so the NFC Shortcut, the Mac launchd script, Claude Code and the PWA can all retry blindly. Eight tables cover every requirement: `settings`, `foods` (foods AND presaved meals, always per 100 g), `food_log` (snapshots), `sessions` (workout, study, sleep, routine, other — one table for everything with a start and end), `sets`, `marks` (routine taps, bed, wake, AM/PM check-ins — one row per item per day), `screen_blocks` (hourly per-app seconds from the Mac script or the phone screenshot path) and `days` (rollup cache). The frontend is Vite + vanilla TypeScript with a hash router and six screens (Today, Food, Train, Study, Review, Settings); charts are inline SVG strings; IndexedDB (idb-keyval) caches each day's payload and holds a write outbox that flushes whenever the app is open and online, because iOS has no Background Sync. The 24-hour day chart is built by one pure function `buildDay(D)` that fills a minute array from sources in strict precedence order (sleep > workout > study > routine > other > mac > phone > unknown), so overlaps never double count and every unfilled minute is visibly "Unknown" and tappable. The Mac contributes automatically via an hourly Python LaunchAgent reading knowledgeC.db; iPhone usage arrives via a Screen Time screenshot pasted into Claude Code, which calls a tiny repo CLI (`tools/planner.mjs`) — the same CLI Claude Code uses to add foods from a nutrition-label photo. Bedtime nudges are iOS-native (Shortcuts Time-of-Day automation), so the server never has to wake the phone. Nothing in the design needs a credit card, a third-party SaaS, or a second server.

## FRONTEND
Vite + vanilla TypeScript, no UI framework: six screens rendered by plain functions that return HTML strings (an `html` tagged template that escapes interpolations) and re-render on data changes only (not on keystrokes, so inputs keep focus), with a hash router (`#/today`, `#/food`, `#/train`, `#/study`, `#/review`, `#/settings`) and one in-memory `store` object that emits `change`. Charts (24 h ribbon, stacked day bars, per-exercise line charts) are inline SVG built with the same template strings — no chart library, since every chart is rects and polylines. Only four runtime dependencies: `idb-keyval` (~600 B, IndexedDB cache + outbox), `barcode-detector` ponyfill (ZXing WASM, lazy-loaded only when the user taps Scan, run against a still photo from `<input type=file capture>` so getUserMedia is never used), `vite-plugin-pwa` (manifest + Workbox precache service worker in `generateSW` mode, `registerType: 'autoUpdate'`), and `wrangler`. A framework would add more concepts (components, reactivity, routing libs, build plugins) than it removes for a one-developer, six-screen app whose state is "the current day's JSON payload".

## SCHEMA
```sql
-- src/worker/schema.sql  --  Cloudflare D1 (SQLite) DDL
-- Apply:  npx wrangler d1 execute planner --remote --file=src/worker/schema.sql
-- Conventions
--   * Every timestamp column (ts, started_at, ended_at, hour, last_used, built_at) is an ISO-8601 UTC string, e.g. 2026-09-28T13:05:00Z
--   * Every "day" column is the user's LOCAL calendar date YYYY-MM-DD, computed by the Worker from env.TZ (never trusted from clients)
--   * ids are client-generated UUIDs, so every POST is an idempotent upsert (INSERT ... ON CONFLICT DO UPDATE)
--   * D1 enforces foreign keys by default; the only FK is sets -> sessions (deleting a session deletes its sets)

-- 1) Key/value settings shared by phone and Mac (JSON-encoded values)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL                       -- JSON
);
INSERT OR IGNORE INTO settings(key, value) VALUES
  ('targets',        '{"kcal":2400,"protein_g":160,"carb_g":260,"fat_g":80}'),
  ('bed_target',     '"23:00"'),            -- local HH:MM
  ('bed_grace_min',  '15'),                 -- minutes late that still count as on time for the streak
  ('weight_unit',    '"kg"'),               -- display only; sets.weight is stored as entered
  ('routine',        '[{"item":"shower","label":"Shower","min":15},{"item":"run","label":"Morning run","min":40},{"item":"stretch","label":"Stretch","min":10},{"item":"shoulders","label":"Shoulder routine","min":10},{"item":"journal","label":"Journal","min":10}]'),
  ('app_categories', '{"com.apple.Terminal":"coding","com.microsoft.VSCode":"coding","com.apple.dt.Xcode":"coding","com.apple.Safari":"browsing","com.google.Chrome":"browsing","com.tinyspeck.slackmacgap":"chat","com.apple.MobileSMS":"chat"}');

-- 2) Foods AND presaved meals, always stored per 100 g
CREATE TABLE IF NOT EXISTS foods (
  id           TEXT PRIMARY KEY,                                  -- uuid
  kind         TEXT NOT NULL DEFAULT 'food' CHECK (kind IN ('food','meal')),
  name         TEXT NOT NULL,
  brand        TEXT,
  barcode      TEXT,                                              -- EAN/UPC digits with leading zeros stripped
  source       TEXT NOT NULL DEFAULT 'label' CHECK (source IN ('label','off','usda','meal','claude')),
  source_id    TEXT,                                              -- OFF code or USDA fdcId
  kcal_100     REAL NOT NULL,
  protein_100  REAL NOT NULL DEFAULT 0,
  carb_100     REAL NOT NULL DEFAULT 0,
  fat_100      REAL NOT NULL DEFAULT 0,
  fiber_100    REAL,
  sugar_100    REAL,
  serving_g    REAL,                                              -- grams in one serving; for a meal = total recipe grams
  serving_text TEXT,                                              -- e.g. '3/4 cup (30 g)'
  label_json   TEXT,                                              -- raw per-serving numbers as typed/read (audit trail)
  recipe_json  TEXT,                                              -- meals only: [{"food_id":"...","name":"Rice","grams":150}, ...]
  use_count    INTEGER NOT NULL DEFAULT 0,                        -- for "frequent first" ordering
  last_used    TEXT
);
CREATE INDEX IF NOT EXISTS foods_name    ON foods(name);
CREATE INDEX IF NOT EXISTS foods_barcode ON foods(barcode);
CREATE INDEX IF NOT EXISTS foods_kind    ON foods(kind, use_count);

-- 3) What was eaten; numbers are SNAPSHOTS so editing/deleting a food never rewrites history
CREATE TABLE IF NOT EXISTS food_log (
  id        TEXT PRIMARY KEY,                                     -- uuid
  day       TEXT NOT NULL,                                        -- local date the entry counts toward
  ts        TEXT NOT NULL,                                        -- when eaten (UTC)
  food_id   TEXT,                                                 -- NULL for a free-form quick entry
  name      TEXT NOT NULL,
  grams     REAL NOT NULL,
  kcal      REAL NOT NULL,
  protein_g REAL NOT NULL DEFAULT 0,
  carb_g    REAL NOT NULL DEFAULT 0,
  fat_g     REAL NOT NULL DEFAULT 0,
  source    TEXT NOT NULL DEFAULT 'app'                           -- app | claude
);
CREATE INDEX IF NOT EXISTS food_log_day ON food_log(day, ts);

-- 4) Anything with a start and an end: workouts, study/project sessions, manual sleep, gap fills
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,                                    -- uuid
  kind       TEXT NOT NULL CHECK (kind IN ('workout','study','sleep','routine','other')),
  day        TEXT NOT NULL,                                       -- local date of started_at
  started_at TEXT NOT NULL,
  ended_at   TEXT,                                                -- NULL while a timer is running
  project    TEXT,                                                -- study: project name; workout: optional label ('Push'); other: label ('lunch')
  note       TEXT,                                                -- study: "what got done"
  source     TEXT NOT NULL DEFAULT 'app'                          -- app | fill (created by tapping an Unknown gap)
);
CREATE INDEX IF NOT EXISTS sessions_day  ON sessions(day, started_at);
CREATE INDEX IF NOT EXISTS sessions_kind ON sessions(kind, project, started_at);

-- 5) One row per set
CREATE TABLE IF NOT EXISTS sets (
  id         TEXT PRIMARY KEY,                                    -- uuid
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts         TEXT NOT NULL,
  exercise   TEXT NOT NULL,                                       -- free text, lower-cased and trimmed by the client
  set_no     INTEGER NOT NULL,                                    -- 1..n within (session, exercise)
  reps       INTEGER NOT NULL,
  weight     REAL NOT NULL DEFAULT 0                              -- 0 = bodyweight; unit per settings.weight_unit
);
CREATE INDEX IF NOT EXISTS sets_exercise ON sets(exercise, ts);
CREATE INDEX IF NOT EXISTS sets_session  ON sets(session_id, ts);

-- 6) One row per item per day: routine taps, bed, wake, and the AM/PM check-ins. The PK is the idempotency key for NFC double taps.
--    item values: any settings.routine item (shower, run, stretch, shoulders, journal), plus bed, wake, am, pm
--    For item='bed', day is the NIGHT's date (a 00:30 tap on the 29th is stored as day = 28th)
CREATE TABLE IF NOT EXISTS marks (
  day    TEXT NOT NULL,
  item   TEXT NOT NULL,
  ts     TEXT NOT NULL,
  note   TEXT,                                                    -- am/pm check-in text
  source TEXT NOT NULL DEFAULT 'nfc',                             -- nfc | app
  PRIMARY KEY (day, item)
);

-- 7) Screen time, hourly, per app. Upsert key = (device, hour, app) so re-sends from the Mac are harmless.
CREATE TABLE IF NOT EXISTS screen_blocks (
  device  TEXT NOT NULL CHECK (device IN ('mac','phone')),
  hour    TEXT NOT NULL,                                          -- UTC hour start, e.g. 2026-09-28T14:00:00Z
  app     TEXT NOT NULL,                                          -- mac: bundle id; phone: '*' (hour total) or a category name
  seconds INTEGER NOT NULL CHECK (seconds BETWEEN 0 AND 3600),
  day     TEXT NOT NULL,                                          -- local date of the hour start (computed by the Worker)
  PRIMARY KEY (device, hour, app)
);
CREATE INDEX IF NOT EXISTS screen_blocks_day ON screen_blocks(day);

-- 8) Rollup cache written by buildDay() (cron for finished days; also refreshed whenever a past day is edited)
CREATE TABLE IF NOT EXISTS days (
  day           TEXT PRIMARY KEY,
  sleep_s       INTEGER NOT NULL DEFAULT 0,                       -- exclusive minutes*60 from the ribbon
  workout_s     INTEGER NOT NULL DEFAULT 0,
  study_s       INTEGER NOT NULL DEFAULT 0,
  routine_s     INTEGER NOT NULL DEFAULT 0,
  other_s       INTEGER NOT NULL DEFAULT 0,
  mac_s         INTEGER NOT NULL DEFAULT 0,
  phone_s       INTEGER NOT NULL DEFAULT 0,
  unknown_s     INTEGER NOT NULL DEFAULT 0,
  kcal          REAL    NOT NULL DEFAULT 0,
  protein_g     REAL    NOT NULL DEFAULT 0,
  carb_g        REAL    NOT NULL DEFAULT 0,
  fat_g         REAL    NOT NULL DEFAULT 0,
  routine_done  INTEGER NOT NULL DEFAULT 0,
  routine_total INTEGER NOT NULL DEFAULT 0,
  bed_ts        TEXT,                                             -- bed mark for the night OF this day
  bed_late_min  INTEGER,                                          -- bed_ts (local) minus bed_target; negative = early
  wake_ts       TEXT,                                             -- explicit wake mark or first activity
  extra         TEXT NOT NULL DEFAULT '{}',                       -- JSON: {"study_by_project":{...},"mac_by_category":{...},"top_apps":[...],"workouts":n,"sets":n}
  built_at      TEXT NOT NULL
);
```

## API
- GET /api/health [none] — Liveness + server clock/timezone; used to test the Shortcut URL and the CLI before tokens are set. | -> {"ok":true,"tz":"America/New_York","now":"2026-09-28T13:05:00Z","today":"2026-09-28"}
- POST /api/marks [app | shortcut] — Log a routine item, bed, wake, or an AM/PM check-in for a day. THE endpoint the NFC Shortcut calls. Idempotent per (day,item). | {"item":"shower", "ts"?:ISO (app only; server time otherwise), "note"?:string (am/pm), "day"?:YYYY-MM-DD (app only)}. Server computes day from ts in env.TZ; item=bed with local hour 04:00-11:59 is stored as item=wake; item=bed with local hour 00:00-03:59 gets day = date-1. shortcut role: INSERT OR IGNORE (first tap wins). app role: ON CONFLICT(day,item) DO UPDATE SET ts, note. -> {"ok":true,"item":"shower","day":"2026-09-28","first":true}
- DELETE /api/marks/:day/:item [app] — Un-mark a routine item / remove a bed or wake mark (long-press in the app). | path params only -> {"ok":true}
- POST /api/screen [app | mac] — Upsert hourly per-app screen-time blocks from the Mac script (device=mac) or from Claude Code's Screen Time screenshot reading (device=phone). | {"device":"mac"|"phone", "blocks":[{"hour":"2026-09-28T14:00:00Z","app":"com.apple.Terminal","seconds":1834}, ...]} (<= 500 blocks). Server clamps seconds to 0..3600, computes day, runs one D1 batch of INSERT ... ON CONFLICT(device,hour,app) DO UPDATE SET seconds=excluded.seconds, and schedules a rollup for any past day touched. -> {"ok":true,"n":37}
- GET /api/day?d=YYYY-MM-DD[&rebuild=1] [app] — Everything the Today screen needs for one day in a single call, including the 24 h timeline built live by buildDay(). | -> {day, today:bool, marks:{shower:{ts,source},...,am:{ts,note},pm:{...}}, bed_last_night:{ts,late_min}|null, bed_tonight:{ts,late_min}|null, wake_ts, streak_nights, routine:[settings order with done flags], food_log:[rows], food_totals:{kcal,protein_g,carb_g,fat_g}, targets, sessions:[rows incl. running ones with ended_at null], sets:[rows for the day's workout sessions], timeline:[{s,e,c,l}] (minute runs since local midnight; c in sleep|workout|study|routine|other|mac|phone|unknown|future; l = label), totals:{sleep_s,...,unknown_s}, hours:[{h:0..23, mac:[{app,seconds,category}], phone:[{app,seconds}]}]}. rebuild=1 forces re-persisting the days row (used after bulk edits).
- GET /api/days?from=YYYY-MM-DD&to=YYYY-MM-DD [app] — Rollup rows for the Review screen (week/month). Missing past days are built on demand and persisted, so Review works before the cron has ever run; today is built live and not persisted. | -> {days:[days rows with extra parsed]} (max 62 days per call)
- GET /api/foods?q=&limit=50 [app] — Search saved foods and meals by name (LIKE %q%); empty q returns meals first then foods by use_count desc. Also used by the CLI to resolve a food name. | -> {foods:[rows]}
- POST /api/foods [app] — Create/update a food or a presaved meal (from the manual label form, OFF/USDA lookup, the meal builder, or Claude Code). | one food row or an array; required: id, name, kcal_100; optional everything else. ON CONFLICT(id) DO UPDATE all columns except use_count/last_used. -> {"ok":true,"ids":[...]}
- DELETE /api/foods/:id [app] — Delete a food/meal (history is unaffected because food_log snapshots numbers). | -> {"ok":true}
- POST /api/food_log [app] — Log an eaten food/meal with snapshot totals; also bumps foods.use_count/last_used. | {id, ts, food_id?, name, grams, kcal, protein_g, carb_g, fat_g, source?} (day computed from ts). Upsert by id so editing grams re-posts the same id. -> {"ok":true,"day":"..."}
- DELETE /api/food_log/:id [app] — Remove a logged entry. | -> {"ok":true}
- POST /api/sessions [app] — Start, stop, edit or create any session: workout, study (timer or manual), sleep (manual), routine, other (Unknown-gap fills). | {id, kind, started_at, ended_at?|null, project?, note?, source?} (day computed from started_at). Upsert by id: start = POST with ended_at null; stop = POST same id with ended_at + note. -> {"ok":true}
- DELETE /api/sessions/:id [app] — Delete a session (its sets cascade). | -> {"ok":true}
- GET /api/sessions?kind=workout|study&project=&before=ISO&limit=30 [app] — Past sessions list for the Train and Study history views (newest first, paginated by before=). | -> {sessions:[{...row, duration_s, set_count, exercises:["bench",...]}]} ; for kind=workout each session also carries sets grouped by exercise.
- POST /api/sets [app] — Log one set (one tap on a pre-filled row) or edit it. | one set row or an array {id, session_id, ts, exercise, set_no, reps, weight}; upsert by id. -> {"ok":true}
- DELETE /api/sets/:id [app] — Remove a set. | -> {"ok":true}
- GET /api/exercises [app] — Distinct exercise names with last_ts and the exercise list of the most recent workout session (for 'same as last time'). | -> {exercises:[{exercise,last_ts,sessions}], last_workout:{session_id, started_at, exercises:[...]}}
- GET /api/exercise?name=bench [app] — Pre-fill + progress data for one exercise: the sets from the most recent session containing it, and per-session best set / est. 1RM / volume for the chart. | -> {last:{session_id, started_at, sets:[{set_no,reps,weight}]}, history:[{day, best_weight, best_reps, e1rm, volume, sets}]} (history = last 60 sessions; e1rm = weight*(1+reps/30); volume = sum reps*weight)
- GET /api/settings [app] — Read all settings (targets, bed_target, routine items, app category map, units). | -> {settings:{key:value}}
- PUT /api/settings [app] — Merge-update settings. | {key:value,...} -> {"ok":true}
- CRON scheduled(): "5 8 * * *" (UTC) [n/a] — Daily rollup: buildDay() for yesterday and the day before (the second pass absorbs Mac blocks that arrived after midnight) and upsert into days. | 08:05 UTC = 04:05 EDT / 03:05 EST; adjust to ~04:00 local for the user's timezone. Two buildDay calls, well under the 10 ms CPU cap.

## SCREENS
### Today (#/today) — The one screen used dozens of times a day: routine, bed/wake, check-ins, calories vs target, running timers, and the 24 h ribbon for the selected day.
  - Date strip (yesterday / today / tomorrow-disabled) — loads GET /api/day?d=; cached copy shown instantly, network result replaces it
  - Routine row: one chip per settings.routine item; tap = POST /api/marks {item}; chip shows tap time; long-press = edit time or un-mark (DELETE)
  - Bed/wake card: 'Last night: in bed 23:41 (41 min late) · streak 3', 'Awake' button (POST marks item=wake), 'In bed' button for tonight (POST marks item=bed), tap the time to correct it
  - AM check-in and PM check-in text areas (one line each: intent / what got done) saved on blur as marks am/pm with note
  - Calories bar + three macro bars vs targets; '+ Food' jumps to Food with the meals list open
  - Running-session banner (study/workout with ended_at null): elapsed from started_at, Stop / Set end time / Discard; on app open a stale running session is surfaced here
  - 24 h ribbon (SVG): colour runs per category, hour ticks, now-marker; tap a run: sessions -> edit/delete sheet; mac/phone -> app list for that hour; Unknown -> fill sheet (category buttons + label, start/end prefilled) which POSTs a sessions row source=fill
  - Legend with totals per category for the day (sleep 7h10, study 3h, mac 5h, unknown 2h ...)
### Food (#/food) — Log meals fast from presaved meals and saved foods; add new foods by label, name search or barcode; build meals.
  - Top: 'Meals' (kind=meal, use_count desc) and 'Frequent' foods as one-tap tiles; tapping opens the portion sheet (1x, 0.5x, 1.5x, or grams) -> POST /api/food_log with snapshot math grams*per100/100
  - Search box filters local foods (GET /api/foods?q= on a debounce, cached list offline); 'Search USDA' button queries /fdc/v1/foods/search (Branded + Foundation/SR Legacy) with the key from Settings; result rows show per-100 g numbers and 'Save & log'
  - 'Scan' button: <input type=file accept=image/* capture=environment> -> createImageBitmap -> barcode-detector ponyfill (ean_13/upc_a/ean_8/upc_e, check digit validated) -> OFF v3 product lookup gated on nutriments['energy-kcal_100g'] presence -> prefilled Add Food form (editable) ; on miss, fall back to USDA search by GTIN then by name
  - 'Add by label' form: serving grams S + per-serving kcal/protein/carb/fat/(fiber/sugar) -> computes per 100 g live, shows the 4/4/9 sanity flag (|4P+4C+9F-kcal| > 15% of kcal), saves label_json for audit
  - Today's log list with totals; swipe/tap to edit grams (re-POST same id) or delete
  - 'Save as meal': multi-select today's entries (or foods + grams) -> name -> POST /api/foods kind=meal with recipe_json, per100 = weighted average, serving_g = total grams
### Train (#/train) — Log every set with reps/weight/exercise, pre-filled from last time; browse past sessions; see progress per exercise.
  - 'Start workout' -> POST sessions kind=workout (ended_at null); 'Same as last time' pulls the exercise list from GET /api/exercises.last_workout
  - Exercise picker: recent exercises first, or type a new name; choosing one calls GET /api/exercise?name= and renders the last session's sets as ghost rows (reps/weight prefilled) each with a single 'Log' button (one tap = POST /api/sets); +/- steppers adjust reps and weight before logging; '+ set' clones the previous row
  - Finish -> POST sessions with ended_at; summary shows total sets/volume vs last session
  - History list (GET /api/sessions?kind=workout): date, label, exercises, set count, duration; tap expands sets grouped by exercise; tap a set to edit/delete
  - Progress: per-exercise SVG line charts (best weight or e1RM, and volume per session) from GET /api/exercise.history
### Study (#/study) — Track side-project/study sessions: how long and what got done, with a timer or manual entry.
  - Project chips (distinct sessions.project) + 'new project'; 'Start' -> POST sessions kind=study started_at=now; timer renders from Date.now()-started_at on every frame and on visibilitychange/pageshow; Screen Wake Lock while the timer view is visible
  - 'Stop' -> sheet asking 'What got done?' -> POST same id with ended_at + note
  - 'Log manually' -> project, duration (or start/end), note -> POST with started_at = ended_at - duration
  - History grouped by day with per-project weekly totals (GET /api/sessions?kind=study); tap to edit note/duration or delete
  - Optional 'Log study' prompt inside the PM check-in on Today shows today's sessions so the end-of-day note can reference them
### Review (#/review) — Spending-tracker style view of time, food, bedtime, routine and study over a week or month.
  - Week/Month toggle and prev/next arrows -> GET /api/days?from&to (today merged live from /api/day)
  - Stacked horizontal bar per day: sleep / workout / study / routine / other / mac / phone / unknown, same colours as the ribbon
  - Category table: hours, % of period, delta vs the previous equal-length period; tapping mac expands mac_by_category and top apps from extra
  - Bedtime: list of nights with bed time and +/- minutes vs target, average lateness, current and best streak
  - Routine completion grid (item x day) and % ; calories per day vs target sparkline; study hours per project; workouts count and total sets
### Settings (#/settings) — One-time setup and the few tunables, kept on the server so phone and Mac agree.
  - API token field (APP_TOKEN, stored in localStorage inside try/catch; never in the bundle) + 'Test' calling GET /api/settings
  - Targets (kcal/protein/carb/fat), bed target and grace minutes, weight unit
  - Routine items editor (item key, label, default minutes, order) -> PUT /api/settings routine; the Shortcut input text must match item keys
  - Mac app category map editor (bundle id -> category), USDA API key
  - Outbox status (pending writes, last error) with 'Retry now'; 'Export' link explaining wrangler d1 export; app version + 'reload'

## OFFLINE/SYNC
Reads: every screen loads through `api.get(path)` which is network-first with an IndexedDB fallback (idb-keyval, keys like `day:2026-09-28`, `foods`, `settings`, `exercise:bench`); the cached copy renders immediately and is replaced when the network answers; an 'offline · cached' pill shows when the fallback was used. The service worker (vite-plugin-pwa, Workbox generateSW, autoUpdate) precaches the app shell only; /api/* is never cached by the SW. Writes: `api.write(method, path, body)` applies the change optimistically to the in-memory day model and the cached day payload, appends {id, method, path, body, ts} to an `outbox` array in IndexedDB, then calls `flush()`. `flush()` runs on app start, on `online`, on `visibilitychange` -> visible, and after every write; it sends outbox entries strictly in order, removes each on 2xx, stops and keeps the queue on network errors or 5xx, drops the entry and shows a toast on 4xx other than 401, and on 401 stops and shows the 'check token' banner. Because every write is an idempotent upsert keyed by a client UUID or a natural key ((day,item), (device,hour,app)), retries and duplicates are harmless, and a write that succeeded but whose response was lost is simply re-sent. Conflict policy is last-write-wins (single user); the only special case is marks from the Shortcut, which are INSERT OR IGNORE so a manual time edit in the app is not overwritten by a later duplicate tap. Timers store absolute `started_at` timestamps server-side the moment they start, so a killed app or a locked screen loses nothing; on next open a session with ended_at null is shown as running with Stop / Set end time / Discard. iOS has no Background Sync, so the outbox flushes only while the app is open; the NFC Shortcut and the Mac script post directly to the Worker and never depend on the PWA. `navigator.storage.persist()` is called once at boot (auto-granted for home-screen apps); the server remains the source of truth, so IndexedDB eviction only costs the offline cache. localStorage holds only the token and the last visited tab, both wrapped in try/catch.

## NFC/SHORTCUTS
One shared shortcut 'Log routine item' with a single action: Get Contents of URL -> POST https://planner.<subdomain>.workers.dev/api/marks, Headers: Authorization = Bearer <SHORTCUT_TOKEN>, Request Body JSON: item = Shortcut Input (Content-Type is set automatically). Run it once manually (type 'shower') to answer the Always Allow prompt and confirm the row. Six NFC personal automations (Run Immediately, Notify When Run off; re-check after every iOS update because updates have flipped this back), one per NTAG213 sticker: shower door, running shoes, stretch mat, shoulder band, journal, and the nightstand; each automation's only action is Run Shortcut 'Log routine item' with Input = the item key (shower, run, stretch, shoulders, journal, bed). Gesture: raise to wake (Face ID unlocks), touch the top edge to the sticker for ~1 s; nothing opens. Server behaviour for the shortcut role: ts = server time, day = local date via env.TZ, INSERT OR IGNORE on PRIMARY KEY(day,item), response {ok, item, day, first} — a double tap returns first:false and changes nothing. The bed sticker is reused for wake: item=bed arriving 04:00-11:59 local is stored as item=wake for that date; item=bed at 00:00-03:59 is stored with day = previous date (the night it belongs to); item=bed from 12:00 on is stored for tonight. Unknown item keys (not in settings.routine and not bed/wake/am/pm) are rejected with 400 so a typo in an automation is visible when you test it. In-app fallback: the Today screen's routine chips, 'In bed' and 'Awake' buttons post the same endpoint with the APP_TOKEN (app role may pass ts to correct a time and upserts instead of ignoring); long-press un-marks via DELETE. Bedtime: a Shortcuts Time-of-Day automation at bed_target minus 30 minutes ('Wind down — bed at 23:00', Show Notification, Run Immediately) and optionally a second one at bed_target; these are purely on-device (no Web Push, no server, never revoked) and are edited by hand if bed_target changes. Lateness: bed_late_min = bed time (local) minus bed_target on the night's date, so 00:20 on the 29th for the night of the 28th is +80; streak = consecutive nights ending with the most recent night where bed_late_min <= bed_grace_min; both shown on Today and in Review. Wake logic for the day chart: explicit wake mark if present, else the earliest of the first routine tap, the first session start, the first food_log entry, or the first hour with >= 5 min of screen time on the day, capped at bed + 12 h; if none and the day is today, sleep runs until now.

## MAC SCRIPT
File: ~/bin/screentime_push.py (kept in the repo as mac/screentime_push.py, symlinked), run by /usr/bin/python3 (Apple's 3.9, stdlib only: sqlite3, shutil, tempfile, json, urllib.request, subprocess, datetime, os). Reads ONLY knowledgeC.db (~/Library/Application Support/Knowledge/knowledgeC.db): copies knowledgeC.db, -wal and -shm to a tempfile.mkdtemp() directory, opens the copy with sqlite3.connect('file:...?mode=ro', uri=True), and runs: SELECT ZOBJECT.ZVALUESTRING AS bundle, ZOBJECT.ZSTARTDATE+978307200 AS s, ZOBJECT.ZENDDATE+978307200 AS e FROM ZOBJECT LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE=ZSOURCE.Z_PK WHERE ZOBJECT.ZSTREAMNAME='/app/usage' AND ZSOURCE.ZDEVICEID IS NULL AND ZOBJECT.ZENDDATE > :since-978307200 ORDER BY s; with :since = watermark - 3 h (the re-sent overlap is harmless because the server upserts). It does NOT query RMAdminStore-Local.sqlite (EPERM even with Full Disk Access on macOS 26.3+) and leaves Biome App.InFocus/remote (iPhone) for a later stretch milestone. Bucketing: each [s,e) interval is split at UTC hour boundaries; seconds are summed per (bundle, hour_start_utc); a small ignore list drops loginwindow/ScreenSaver/dock; only hours whose end <= now are sent plus the current partial hour (it is re-sent and overwritten on the next run); each value is clamped to 3600. Posts one JSON body to $PLANNER_URL/api/screen: {"device":"mac","blocks":[{"hour":"2026-09-28T14:00:00Z","app":"com.apple.Terminal","seconds":1834}, ...]} with Authorization: Bearer <MAC_TOKEN> and Content-Type: application/json via urllib.request.urlopen(req, timeout=30); on 2xx it writes the newest complete hour to ~/.config/planner/last_hour (the watermark), on failure it leaves the watermark alone so the next run resends; the temp dir is always removed. Token: stored once with `security add-generic-password -a planner -s planner-mac -w` and read at runtime with `security find-generic-password -a planner -s planner-mac -w` (never in the plist, which must be 0644). Scheduling: ~/Library/LaunchAgents/com.pranav.screentime-push.plist with ProgramArguments [/usr/bin/python3, /Users/pranavgadiraju/bin/screentime_push.py], StartCalendarInterval Minute=5 (every hour at :05), RunAtLoad true, EnvironmentVariables PLANNER_URL, StandardOut/ErrorPath under ~/Library/Logs/; load with `launchctl bootstrap gui/$(id -u) <plist>` and test with `launchctl kickstart -k gui/$(id -u)/com.pranav.screentime-push`. Full Disk Access: grant to the exact executable /usr/bin/python3 (System Settings > Privacy & Security > Full Disk Access; drag /usr/bin/python3 into the list if the + picker fails, a known 26.1-26.2 bug reportedly fixed in 26.3), then verify with `sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "select client,auth_value from access where service='kTCCServiceSystemPolicyAllFiles'"` (auth_value 2) and the one-line python read test from the digest; also grant Terminal for manual runs. Volume: ~10-30 rows per hour, ~700 rows/day, far below D1's 100k writes/day even with index writes. Server side the day column is computed from the UTC hour in env.TZ, and any block for a past day triggers a rollup of that day.

## DAY CHART
buildDay(D) in src/worker/day.ts (pure function, also used by the cron and by GET /api/days for missing rows):
0. Window: midnight = local midnight of D in env.TZ expressed as a UTC instant; end = local midnight of D+1; N = (end-midnight)/60000 (1440 normally, 1380/1500 on DST days). cat = Uint8Array(N) all 0 (0=unknown), lab = Array(N) of null. nowMin = D is today ? floor((now-midnight)/60000) : N.
1. Load with one D1 batch: marks WHERE day IN (D-1, D); sessions WHERE day IN (D-1, D) AND started_at < end AND (ended_at IS NULL OR ended_at > midnight); screen_blocks WHERE day = D; food_log WHERE day = D; settings routine, app_categories, bed_target, bed_grace_min.
2. fill(startTs, endTs, c, label): clip [start,end) to [midnight, end) and to [0, nowMin); for each minute m in [floor(start), ceil(end)) if cat[m]==0 then cat[m]=c, lab[m]=label. Because fill only writes into still-unknown minutes, the CALL ORDER IS THE PRECEDENCE: earlier sources win every overlap and nothing is ever counted twice. Within one source, rows are processed in started_at order, so the earlier session wins an overlap and the later one is clipped.
3. Sources, in order:
   a. SLEEP. bedPrev = marks(D-1,'bed'); if present: wake = marks(D,'wake').ts, else earliest of {first routine mark on D, first sessions.started_at on D after bedPrev, first food_log.ts on D, first hour on D with sum(screen seconds) >= 300}, capped at bedPrev+12h; if nothing and D is today, wake = now; fill(bedPrev, wake, sleep). bedTonight = marks(D,'bed'); if present fill(bedTonight, end, sleep). Then every sessions row kind='sleep' (manual fills, naps).
   b. WORKOUT: sessions kind='workout', ended_at ?? now, label = project.
   c. STUDY: sessions kind='study', label = project.
   d. ROUTINE: for each routine item (settings order) with a mark on D: start = ts; end = min(ts + item.min*60 s, ts of the next routine mark on D); fill(routine, item). Convention: tap the sticker when you START the item. Then sessions kind='routine'.
   e. OTHER: sessions kind='other', label = project (e.g. lunch, errands).
   f. MAC: for each local hour H of D (hour rows are keyed by UTC hour; the local day was assigned at insert): rows = screen_blocks(device='mac', hour=H) sorted by seconds desc; for each row need = round(seconds/60); walk the minutes of H from its start, assigning unknown minutes to cat=mac, lab = app_categories[bundle] ?? bundle short name, until need == 0 or the hour ends. So an hour with 45 min Terminal + 20 min Safari but a 30-min study session already in it shows 30 min study, 30 min mac(coding) and nothing for Safari — the ribbon is exclusive time; the hour tooltip and mac_by_category use the raw seconds.
   g. PHONE: same walk with device='phone' rows (app='*' from the screenshot path, or category names) -> cat=phone. Phone only fills what mac left, so overlapping mac+phone use never exceeds 60 min/hour.
   h. Remaining minutes: m < nowMin -> unknown; m >= nowMin -> future (today only, never stored).
4. Compress to runs [{s,e,c,l}] by merging adjacent equal (c,l); totals[c] = minutes*60. Runs are what the ribbon draws and what the tap-to-fill sheet uses as prefilled start/end.
5. Derived values stored alongside: kcal/protein/carb/fat = SUM(food_log); routine_done = count of routine items marked, routine_total = routine.length; bed_ts = bedTonight.ts, bed_late_min = (bedTonight local time) - (bed_target on D), i.e. 00:20 next day = +80; wake_ts as computed; extra = {study_by_project: raw sum(ended-started) per project (raw, may exceed study_s when overlapped), mac_by_category and top_apps: raw seconds from screen_blocks, workouts: n, sets: n}.
6. Persist: if D < today, upsert into days; today's row is returned but not stored. Rebuild triggers: the cron (yesterday and the day before), any app/mac write whose day < today (ctx.waitUntil(buildDay(day))), GET /api/day?rebuild=1, and GET /api/days for missing rows.
Weekly/monthly (Review): GET /api/days?from&to returns the days rows (today merged live). Client sums each *_s column over the range; percentages are of N_days*24 h with unknown shown as its own grey category (like 'uncategorised spending'); delta = this period minus the previous equal-length period; per-day stacked bars use the same eight categories and colours as the ribbon; bedtime list, streak (walk back from the last night while bed_late_min <= grace), routine completion = SUM(routine_done)/SUM(routine_total), kcal average vs targets, study_by_project summed from extra. Unknown gaps: tapping an unknown run on Today opens the fill sheet -> POST /api/sessions {kind, project/label, started_at, ended_at, source:'fill'}; the day is rebuilt so the gap disappears immediately (optimistically in the client, then server-side).

## CLAUDE CODE HELPERS
Repo files: CLAUDE.md (recipes below) and tools/planner.mjs (Node >= 18, zero dependencies, ~120 lines). Config: ~/.config/planner/config.json {"url":"https://planner.<sub>.workers.dev","token":"<APP_TOKEN>"} chmod 600 (Claude Code runs as you on your own Mac, so it uses the full-access APP_TOKEN; the Mac script keeps its own write-only MAC_TOKEN in the Keychain). Commands: (1) `node tools/planner.mjs food '<json>' [--log <grams>]` -> POST /api/foods with a generated uuid (required: name, kcal_100, protein_100, carb_100, fat_100; optional fiber_100, sugar_100, serving_g, serving_text, brand, barcode, label_json, source:'claude'); with --log it also POSTs /api/food_log now; prints the saved row. (2) `node tools/planner.mjs log "<food name or id>" <grams> [--at 2026-09-28T12:30] [--day YYYY-MM-DD]` -> resolves via GET /api/foods?q=, computes snapshot totals, POSTs /api/food_log. (3) `node tools/planner.mjs screen phone <YYYY-MM-DD> '{"0":12,"7":25,"8":40,...}'` -> minutes per LOCAL hour; the CLI converts each local hour of that date to a UTC hour string and POSTs /api/screen {device:'phone', blocks:[{hour, app:'*', seconds}]}; omitted hours are left unknown. (4) `node tools/planner.mjs day [YYYY-MM-DD]` -> GET /api/day and prints totals, food, sessions and the ribbon as text so Claude can answer 'how did yesterday go'. CLAUDE.md recipes: NUTRITION LABEL — 'When I paste a nutrition label photo: read serving size in grams S (if only a household measure is given, ask me for the weighed grams); per-100 g = per-serving x 100 / S for kcal, protein, carbs, fat, fiber, sugars; check |4P + 4C + 9F - kcal| <= 15% of kcal and flag if not; show the table; then run planner food with source:"claude", serving_g:S, label_json = the raw per-serving numbers; ask before --log.' SCREEN TIME SCREENSHOT — 'When I paste an iPhone Screen Time Day view: read the date and the 24 hourly bars as minutes (0-60); list them as JSON {"hour":minutes}; hours you cannot read are omitted; then run planner screen phone <date> <json>; grey/unattributed time counts in the hour total.' MEALS — 'A presaved meal is a food with kind:"meal": items [{name, grams, per100 values}] -> per100 = sum(item.per100 x grams)/total_g, serving_g = total_g, recipe_json = items; post it with planner food.' Everything the CLI does is an idempotent upsert, so re-running a command after a failure is safe.

## MILESTONES
- **M1 — Routine stickers, bed/wake, check-ins (usable tomorrow morning)**: Repo scaffold (wrangler.jsonc with assets dir ./dist, run_worker_first ['/api/*'], D1 binding, vars.TZ, cron '5 8 * * *'; vite.config.ts with vite-plugin-pwa; manifest + 180/192/512 icons). Full schema.sql applied. Worker: auth (three secrets, timingSafeEqual, roles), GET /api/health, POST/DELETE /api/marks, GET/PUT /api/settings, GET /api/day (marks, bed/wake, streak, routine list; timeline may be empty), scheduled() stub. App: api.ts with token, outbox and day cache; Today screen with routine chips, bed/wake card, AM/PM check-ins; Settings with token field and routine editor. Shortcut 'Log routine item' + 6 NFC automations + bedtime Time-of-Day automation. PWA installed on iPhone (Add to Home Screen) and Mac (Add to Dock).
  - verify: Tap the shower sticker: within 5 s `wrangler d1 execute --command "select * from marks"` shows one row; tap again: still one row and the response has first:false. Open the app: the chip shows the tap time; long-press un-marks it. Tap the nightstand sticker at 23:40: Today shows 'in bed 23:40 (40 min late)' next morning; tap it again at 07:10: a wake mark appears. Airplane mode, tap a chip in the app, go online: the outbox flushes and the row appears. Health check from the Mac: curl /api/health returns today's local date.
- **M2 — Food: foods, meals, log, targets, Claude Code label helper**: Endpoints GET/POST/DELETE /api/foods, POST/DELETE /api/food_log; /api/day returns food_log + totals + targets. Food screen: meals/frequent tiles, portion sheet, search, Add-by-label form with per-100 g math and 4/4/9 flag, today's log, Save-as-meal builder. USDA name search (key in Settings). Today calorie/macro bars. tools/planner.mjs food/log/day + CLAUDE.md.
  - verify: Enter a label (30 g serving, 120 kcal) -> food shows 400 kcal/100 g. Log 45 g -> 180 kcal appears in Today's bar. Build a meal from two foods, log it at 0.5x in two taps; totals equal hand math. Paste a label photo into Claude Code: it prints the table, runs planner food, and the food appears in the app's search. USDA search 'chicken breast raw' returns per-100 g rows that save and log.
- **M3 — Workouts: sessions, sets, pre-fill, history, progress**: Endpoints POST/DELETE /api/sessions, GET /api/sessions, POST/DELETE /api/sets, GET /api/exercises, GET /api/exercise. Train screen: start workout, 'same as last time', exercise picker, ghost rows pre-filled from the last session with one-tap Log, steppers, finish, history list with expandable sets, per-exercise SVG progress charts.
  - verify: Session 1: log bench 3x8@60. Session 2: choose bench -> three ghost rows show 8@60; tapping Log three times creates three sets rows with correct set_no. History shows both sessions; the bench chart shows two points (best 60, volume 1440). Kill the app mid-workout, reopen: the running session banner offers Stop / Set end time.
- **M4 — Study sessions: timer, manual entry, notes**: Study screen: project chips, Start/Stop timer with absolute timestamps and Screen Wake Lock, 'what got done' note on stop, manual entry (duration + note), history per project with weekly totals; PM check-in shows today's study sessions.
  - verify: Start a timer, lock the phone for 10 min, unlock: elapsed reads ~10:00, not 0. Stop with a note: the session shows the correct duration and note on the Mac within one refresh. Manual entry of 90 min yesterday lands on yesterday (day computed from started_at).
- **M5 — 24 h day chart, rollups, Review, gap filling**: buildDay() with the precedence fill, /api/day timeline+totals+hours, GET /api/days, cron rollup for D-1 and D-2, rebuild-on-past-write. Today: SVG ribbon with tap sheets (edit session / fill Unknown / hour app list) and legend totals. Review screen: week/month toggle, stacked bars, category table with deltas, bedtime list + streak, routine grid, kcal sparkline, study by project.
  - verify: Timeline runs sum to exactly N minutes (1440) for any day, including a DST day. Overlap test: study 10:00-11:00 and workout 10:30-11:30 -> workout 10:30-11:30, study 10:00-10:30, nothing double counted. Tap an Unknown gap, choose Other 'lunch': the gap turns into a run immediately and survives reload. After the cron at 04:05 local, `select day, unknown_s from days` has yesterday's row; editing a session from two days ago updates that row within seconds.
- **M6 — Mac screen time (launchd + knowledgeC) and phone screenshot helper**: mac/screentime_push.py, LaunchAgent plist, Keychain token, FDA grant procedure; POST /api/screen with mac role; app_categories map in Settings; ribbon shows mac runs labelled by category and phone runs; hour tooltip lists apps. tools/planner.mjs screen phone + CLAUDE.md recipe.
  - verify: TCC.db query lists /usr/bin/python3 with auth_value 2 and the one-line python read prints a row count > 0. `launchctl kickstart` writes ~/.config/planner/last_hour and `select count(*) from screen_blocks where device='mac'` grows; running it twice does not change the count. The previous hour on the Mac ribbon shows mac minutes roughly matching System Settings > Screen Time. Paste a Screen Time screenshot into Claude Code: phone minutes appear in the matching hours and the unknown total drops accordingly.
- **M7 — Barcode + OFF, polish, backups (and optional iPhone Biome stretch)**: Scan button using <input type=file capture> + barcode-detector ponyfill (still image) + OFF v3 lookup gated on energy-kcal_100g with USDA GTIN fallback; local barcode cache in foods.barcode. Weekly `wrangler d1 export` LaunchAgent to ~/planner-backups. Outbox retry UI in Settings. Optional stretch: aw-import-screentime-based decoder for Biome App.InFocus/remote to post per-app phone hours automatically.
  - verify: Photograph a cereal box barcode: the Add Food form is prefilled from OFF within 3 s; a junk OFF placeholder (status 1, no kcal) falls through to USDA. Backup file appears weekly and `sqlite3 backup.sql`-restores into a local D1 (`wrangler d1 execute --local --file`). Outbox shows 0 pending after reconnecting.

## RISKS
- knowledgeC.db '/app/usage' could stop being populated in a future macOS release (Apple has been moving data to Biome); mitigation: the ribbon degrades to Unknown, and ActivityWatch (localhost:5600, no FDA) is a drop-in replacement source for the same POST /api/screen shape.
- Full Disk Access for a bare /usr/bin/python3 was silently broken in macOS 26.1-26.2; on 26.6.2 verify via the TCC.db query rather than the UI, and fall back to dragging the binary into the list or wrapping the script in a signed .app.
- /usr/bin/python3 requires Xcode Command Line Tools; if `xcode-select -p` fails, install CLT first (the FDA grant must match the exact executable path launchd runs).
- iOS updates have flipped NFC automations back to 'Ask Before Running'; a locked-but-awake phone may show a notification instead of posting silently. Re-test after each iOS update; the in-app chips are the fallback.
- Personal automations do not sync via iCloud: all six NFC automations must be recreated on a new iPhone.
- Cloudflare free-tier terms change (D1 limits became hard-enforced Sept 2026); volumes here are <2% of any quota, but the 10 ms CPU cap per invocation (including cron) means buildDay must stay a tight loop over at most a few thousand minutes and avoid JSON-heavy processing.
- Cron runs in UTC, so the rollup time shifts by an hour across DST; harmless because rebuild-on-write and GET /api/days also fill rows.
- Timezone assumption: local days are assigned per UTC hour, which is exact only for whole-hour offsets; a half-hour timezone would mis-assign 30 minutes at midnight.
- APP_TOKEN lives in localStorage on the phone and Mac; anyone with the device unlocked can read data. No third-party scripts run on the origin, so XSS exposure is limited to the app's own code; rotate with `wrangler secret put` if a device is lost.
- USDA API key is embedded in client storage (Settings), acceptable for a private app but must never be committed; OFF search is unreliable so only barcode lookups are used, and OFF placeholder products require the energy-kcal_100g gate.
- Routine blocks on the ribbon are estimates (tap time + default minutes) and assume the tap happens at the start of the item; a wrong convention shifts blocks by their duration.
- Wake detection without a wake tap is heuristic (first activity); sleep shown on the chart can be wrong by the length of a quiet morning.
- iPhone usage is manual (screenshot -> Claude Code) unless the Biome decoder stretch is done; those hours otherwise show as Unknown.
- Single-user last-write-wins: editing the same row on phone and Mac while one is offline will let the later flush overwrite the earlier edit.
- Camera permission for <input type=file capture> is handled by the system picker, but barcode decoding from a still photo can fail on blurry shots; the user just retakes.
- D1 has no automatic off-platform backups beyond 7-day Time Travel; the weekly `wrangler d1 export` LaunchAgent is the safety net and must actually be loaded.

## OPEN QUESTIONS
- Timezone for env.TZ and the cron hour — America/New_York (08:05 UTC = 04:05 EDT) or something else?
- Weight unit for sets: kg or lb?
- Default bed target and grace: 23:00 with 15 min, or different? Should the wind-down notification fire 30 min before?
- Sticker convention: do you tap when you START a routine item (assumed) or when you finish? This decides where routine blocks sit on the ribbon.
- Is reusing the nightstand sticker for wake (bed tap between 04:00 and 11:59 = wake) fine, or do you prefer an explicit in-app 'Awake' button only?
- Default durations per routine item for the chart (shower 15, run 40, stretch 10, shoulders 10, journal 10 assumed) — adjust?
- Which Mac apps count as 'coding' vs 'browsing' vs 'chat' — or start with raw app names and add the category map later?
- Fixed daily calorie/macro targets (assumed 2400 kcal / 160 P / 260 C / 80 F placeholders) — what are yours?
- Is it OK for Claude Code to use the full-access APP_TOKEN from ~/.config/planner/config.json, or do you want a fourth write-only token for it?
- workers.dev subdomain is enough, or do you want a custom domain on Cloudflare (affects the Shortcut and script URLs)?
- Is Xcode Command Line Tools installed (`xcode-select -p`) so /usr/bin/python3 exists for the Mac script?
- Should the PM check-in be a single free-text line (assumed) or structured (done / blocked / tomorrow's first task)?


####################################################################################################
# DESIGN: AUTOMATION: minimise daily typing; NFC + Shortcuts + Mac telemetry + Claude Code
####################################################################################################

## OVERVIEW
One Cloudflare Worker ('planner') serves the Vite-built PWA as static assets and answers JSON under /api/*, backed by one D1 database and one hourly Cron Trigger. Every daily input has a zero-typing path: six to eight NFC stickers fire a single shared iOS Shortcut that POSTs {item} to /api/tap (five routine items, a nightstand 'bed' sticker, a desk 'study' toggle, an optional 'workout' toggle) and an Alarm-Is-Stopped automation posts 'wake'; a launchd Python script pushes second-resolution Mac app intervals from knowledgeC.db every hour; Claude Code on the Mac is the typing surrogate for photos (nutrition labels, iPhone Screen Time screenshots) and for terminal-native logging through a tiny CLI that calls the same API. The Worker derives state at ingest time (routine_checks, sleep_nights with lateness, session start/stop, dirty-day marks) so the phone never has to be open for automation to land. The PWA mirrors data into IndexedDB with a write outbox, so it is instantly usable offline on phone and Mac, and on every foreground it turns what is missing into one-tap cards: confirm an inferred bedtime, add the missing 'what got done' note after an NFC stop, categorise a new Mac app, log the same meal or set as last time, accept a suggested study session inferred from 40 minutes of VS Code. The 24-hour day chart is a pure function buildDay(inputs) shared by Worker and PWA that layers manual overrides > sleep > workouts > study sessions > routine blocks > Mac app intervals > phone hourly fill, leaves Unknown visible and tappable, and cron persists a day_summary row per day so weekly and monthly views cost one small query. Auth is three static bearer tokens; the Shortcut and Mac tokens can only write. Total D1 writes stay under ~10k/day and no request or cron run approaches the 10 ms CPU budget because the heavy timeline work is cached per day and recomputed only when a day is marked dirty.

## FRONTEND
Preact + @preact/signals + preact-iso (router with lazy routes), TypeScript, Vite with vite-plugin-pwa (generateSW precaches the shell only; /api is never cached by the service worker because IndexedDB is the data cache). Preact keeps the bundle around 10 kB so cold launches from the Home Screen are instant, signals make optimistic local-first state trivial, and a monorepo package 'core' (buildDay, nutrition math, e1RM, tap-routing rules) is imported by both the Worker and the app so client-side recomputes match the server exactly. Charts are hand-written SVG components (24-hour timeline column, stacked weekly bars, exercise line chart, calorie ring) rather than a library: a few hundred lines, themable, no dependency risk, and the timeline needs custom hit-testing for tap-to-fill anyway. IndexedDB goes through 'idb' (1 kB) with a hand-rolled outbox; barcode decoding uses the 'barcode-detector' ponyfill on a still photo from <input type=file capture> (getUserMedia is buggy in installed web apps on iOS 26/27, and native BarcodeDetector is disabled in Safari).

## SCHEMA
```sql
-- planner schema.sql  (Cloudflare D1 / SQLite). Apply: npx wrangler d1 execute planner --remote --file=schema.sql
-- Conventions
--  * *_ts / *_at columns are INTEGER unix seconds (UTC). ISO strings sent by Shortcuts are parsed by the Worker.
--  * `day` / `sleep_day` are the user's LOCAL calendar date 'YYYY-MM-DD', computed by the Worker with
--    Intl.DateTimeFormat(settings.tz) at write time (SQLite has no tz database; cron runs in UTC).
--  * ids are TEXT UUIDs generated by the client (offline-first) or by the Worker; inserts are INSERT OR IGNORE /
--    ON CONFLICT upserts keyed on that id so outbox retries are idempotent.
--  * user-editable tables carry updated_at + deleted_at (soft delete) so GET /api/changes?since= can sync the PWA.
--  * D1 enforces foreign keys by default (no PRAGMA needed).

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,            -- JSON encoded
  updated_at INTEGER NOT NULL
);
-- keys: tz, bed_target ("23:00"), bed_grace_min, winddown_min, routine_deadline ("11:00"), weight_unit,
--       usda_api_key, default_project_id, session_autostop_h, min_sleep_h

CREATE TABLE IF NOT EXISTS routine_items (
  id          TEXT PRIMARY KEY,                 -- slug the Shortcut sends: shower, run, stretch, shoulders, journal
  name        TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  est_minutes INTEGER NOT NULL DEFAULT 10,      -- block length drawn on the day chart (tap = start of the item)
  category    TEXT NOT NULL DEFAULT 'routine',  -- day-chart category; 'workout' for the run
  active      INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);

-- Raw append-only log of every automation call (audit; shows double taps and failed toggles)
CREATE TABLE IF NOT EXISTS events (
  id     TEXT PRIMARY KEY,
  ts     INTEGER NOT NULL,
  day    TEXT NOT NULL,
  kind   TEXT NOT NULL,      -- 'tap' | 'screentime' | 'food' | 'session' | 'cron'
  item   TEXT,               -- 'shower','bed','wake','study','workout','app_open',...
  source TEXT NOT NULL,      -- 'nfc' | 'shortcut' | 'app' | 'mac' | 'claude' | 'cron'
  result TEXT NOT NULL,      -- 'created' | 'duplicate' | 'started' | 'stopped' | 'ignored' | 'error'
  meta   TEXT                -- JSON: raw body, message returned
);
CREATE INDEX IF NOT EXISTS ix_events_ts  ON events(ts);
CREATE INDEX IF NOT EXISTS ix_events_day ON events(day, kind);

CREATE TABLE IF NOT EXISTS routine_checks (
  item_id    TEXT NOT NULL REFERENCES routine_items(id),
  day        TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  source     TEXT NOT NULL,             -- 'nfc' | 'app'
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, day)            -- idempotent: one check per item per local day
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_routine_checks_day ON routine_checks(day);

CREATE TABLE IF NOT EXISTS sleep_nights (
  sleep_day     TEXT PRIMARY KEY,       -- local date of the EVENING; a 00:40 bed tap belongs to the previous date
  bed_ts        INTEGER,                -- accepted "in bed" time (latest tap that night, see /api/tap rules)
  first_bed_ts  INTEGER,                -- first tap that night, kept for honesty
  wake_ts       INTEGER,
  bed_source    TEXT,                   -- 'nfc' | 'app' | 'inferred'
  wake_source   TEXT,                   -- 'alarm' | 'nfc' | 'app' | 'routine' | 'app_open' | 'mac' | 'inferred'
  target_bed_ts INTEGER NOT NULL,       -- settings.bed_target on sleep_day resolved to unix
  late_min      INTEGER,                -- (bed_ts - target_bed_ts)/60, negative = early
  confirmed     INTEGER NOT NULL DEFAULT 0,  -- 1 = explicit tap, or user confirmed an inference
  updated_at    INTEGER NOT NULL
);

-- ---------- Meals ----------
CREATE TABLE IF NOT EXISTS foods (              -- everything stored per 100 g
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  brand        TEXT,
  source       TEXT NOT NULL,                   -- 'label' | 'off' | 'usda' | 'claude'
  source_id    TEXT,                            -- barcode (OFF) or fdcId (USDA)
  kcal_100     REAL NOT NULL,
  protein_100  REAL NOT NULL DEFAULT 0,
  carb_100     REAL NOT NULL DEFAULT 0,
  fat_100      REAL NOT NULL DEFAULT 0,
  fiber_100    REAL,
  sugar_100    REAL,
  serving_g    REAL,                            -- one label serving in grams (preset button)
  serving_text TEXT,                            -- e.g. '3/4 cup (30g)'
  label_json   TEXT,                            -- raw per-serving numbers as printed (audit)
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_foods_source ON foods(source, source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_foods_name   ON foods(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS ix_foods_recent ON foods(last_used_at DESC);

CREATE TABLE IF NOT EXISTS meals (              -- presaved meals = recipes of (food, grams)
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  note         TEXT,
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE TABLE IF NOT EXISTS meal_items (
  meal_id TEXT NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  food_id TEXT NOT NULL REFERENCES foods(id),
  grams   REAL NOT NULL,
  sort    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (meal_id, food_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS food_log (
  id         TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  day        TEXT NOT NULL,
  food_id    TEXT REFERENCES foods(id),
  meal_id    TEXT REFERENCES meals(id),
  grams      REAL,                              -- when food_id
  scale      REAL,                              -- when meal_id (1.0 = whole recipe)
  name       TEXT NOT NULL,                     -- snapshot so later edits do not rewrite history
  kcal       REAL NOT NULL,
  protein_g  REAL NOT NULL,
  carb_g     REAL NOT NULL,
  fat_g      REAL NOT NULL,
  fiber_g    REAL,
  sugar_g    REAL,
  source     TEXT NOT NULL,                     -- 'app' | 'claude'
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_food_log_day ON food_log(day);

CREATE TABLE IF NOT EXISTS nutrition_targets (
  effective_from TEXT PRIMARY KEY,              -- local date; the row with the greatest date <= day applies
  kcal       INTEGER NOT NULL,
  protein_g  INTEGER NOT NULL,
  carb_g     INTEGER NOT NULL,
  fat_g      INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ---------- Workouts ----------
CREATE TABLE IF NOT EXISTS exercises (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  muscle       TEXT,
  load_type    TEXT NOT NULL DEFAULT 'weight',  -- 'weight' | 'bodyweight' | 'time'
  last_used_at INTEGER,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE TABLE IF NOT EXISTS workout_sessions (
  id         TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,                           -- NULL = in progress
  day        TEXT NOT NULL,
  note       TEXT,
  source     TEXT NOT NULL,                     -- 'app' | 'nfc' | 'auto_stop'
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_workout_sessions_day  ON workout_sessions(day);
CREATE INDEX IF NOT EXISTS ix_workout_sessions_open ON workout_sessions(started_at) WHERE ended_at IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sets (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  set_no      INTEGER NOT NULL,
  reps        INTEGER NOT NULL,
  weight      REAL NOT NULL DEFAULT 0,          -- in settings.weight_unit; 0 for bodyweight
  is_warmup   INTEGER NOT NULL DEFAULT 0,
  ts          INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sets_session  ON sets(session_id, set_no);
CREATE INDEX IF NOT EXISTS ix_sets_exercise ON sets(exercise_id, ts);

-- ---------- Projects / study ----------
CREATE TABLE IF NOT EXISTS projects (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  color      TEXT,
  sort       INTEGER NOT NULL DEFAULT 0,
  archived   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS work_sessions (
  id         TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  started_at INTEGER NOT NULL,
  ended_at   INTEGER,                           -- NULL = timer running
  day        TEXT NOT NULL,
  note       TEXT,                              -- "what got done"; NULL after an NFC stop => app prompts for it
  source     TEXT NOT NULL,                     -- 'app' | 'nfc' | 'claude' | 'mac_suggest' | 'auto_stop'
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_work_sessions_day     ON work_sessions(day);
CREATE INDEX IF NOT EXISTS ix_work_sessions_project ON work_sessions(project_id, started_at);
CREATE INDEX IF NOT EXISTS ix_work_sessions_open    ON work_sessions(started_at) WHERE ended_at IS NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS checkins (
  day          TEXT PRIMARY KEY,
  morning_ts   INTEGER,
  morning_json TEXT,       -- {"intentions":["..."],"planned_hours":3}
  evening_ts   INTEGER,
  evening_json TEXT,       -- {"rating":4,"done":"...","tomorrow":"..."}
  updated_at   INTEGER NOT NULL
);

-- ---------- Screen time ----------
CREATE TABLE IF NOT EXISTS screen_intervals (   -- second-resolution Mac app usage from knowledgeC '/app/usage'
  device   TEXT NOT NULL,                       -- 'mac'
  bundle   TEXT NOT NULL,
  start_ts INTEGER NOT NULL,
  end_ts   INTEGER NOT NULL,
  PRIMARY KEY (device, start_ts, bundle)        -- upsert target; re-sends never duplicate
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS ix_screen_intervals_end ON screen_intervals(device, end_ts);

CREATE TABLE IF NOT EXISTS screen_hours (       -- coarse totals: iPhone from a Screen Time screenshot (via Claude Code) or Biome later
  device      TEXT NOT NULL,                    -- 'iphone'
  hour_start  INTEGER NOT NULL,                 -- unix of the local hour; for granularity='day' the local midnight
  item        TEXT NOT NULL,                    -- 'category:Social' | 'app:Instagram' | 'total'
  seconds     INTEGER NOT NULL,
  granularity TEXT NOT NULL DEFAULT 'hour',     -- 'hour' rows feed the timeline; 'day' rows feed "top apps"
  source      TEXT NOT NULL,                    -- 'screenshot' | 'biome'
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (device, hour_start, item)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS app_categories (
  bundle       TEXT PRIMARY KEY,
  label        TEXT,                            -- display name sent by the Mac script
  category     TEXT,                            -- 'code' | 'browse' | 'comms' | 'media' | 'docs' | 'other'; NULL = needs triage
  seen_seconds INTEGER NOT NULL DEFAULT 0,      -- orders the triage list
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS manual_blocks (      -- gaps the user filled or overrides drawn on the day chart
  id         TEXT PRIMARY KEY,
  day        TEXT NOT NULL,
  start_ts   INTEGER NOT NULL,
  end_ts     INTEGER NOT NULL,
  category   TEXT NOT NULL,                     -- 'sleep'|'workout'|'study'|'routine'|'eating'|'chores'|'social'|'commute'|'leisure'|'other'
  label      TEXT,
  project_id TEXT REFERENCES projects(id),
  source     TEXT NOT NULL DEFAULT 'app',
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_manual_blocks_day ON manual_blocks(day);

-- ---------- Derived ----------
CREATE TABLE IF NOT EXISTS dirty_days (         -- every write touching a day inserts its date; reads/cron recompute then delete
  day       TEXT PRIMARY KEY,
  marked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS day_summary (        -- one row per local day, maintained by cron + lazy recompute on read
  day                TEXT PRIMARY KEY,
  sleep_s            INTEGER NOT NULL DEFAULT 0,
  workout_s          INTEGER NOT NULL DEFAULT 0,
  study_s            INTEGER NOT NULL DEFAULT 0,
  routine_s          INTEGER NOT NULL DEFAULT 0,
  mac_s              INTEGER NOT NULL DEFAULT 0, -- Mac time not already inside a study/workout/routine block
  phone_s            INTEGER NOT NULL DEFAULT 0,
  other_s            INTEGER NOT NULL DEFAULT 0, -- manual categories (eating, chores, social, ...)
  unknown_s          INTEGER NOT NULL DEFAULT 0,
  mac_by_cat_json    TEXT,                       -- {"code":5400,"browse":1200,...} all Mac time incl. inside study
  study_by_proj_json TEXT,                       -- {"<project_id>":3600,...}
  kcal               REAL,
  protein_g          REAL,
  carb_g             REAL,
  fat_g              REAL,
  routine_done       INTEGER NOT NULL DEFAULT 0,
  routine_total      INTEGER NOT NULL DEFAULT 0,
  bed_late_min       INTEGER,
  bed_streak         INTEGER,
  workout_sets       INTEGER NOT NULL DEFAULT 0,
  blocks_json        TEXT,                       -- cached buildDay() output: blocks + gaps + suggestions
  final              INTEGER NOT NULL DEFAULT 0, -- 1 once day < today-1 and recomputed; served from cache until dirtied
  computed_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_health (  -- surfaced on Today when something stops flowing
  source        TEXT PRIMARY KEY,               -- 'mac' | 'nfc' | 'shortcut' | 'claude' | 'cron'
  last_ok_ts    INTEGER,
  last_error_ts INTEGER,
  last_error    TEXT,
  detail        TEXT                            -- JSON, e.g. {"watermark":1727500000,"rows":412}
);

-- ---------- Seed ----------
INSERT OR IGNORE INTO settings(key,value,updated_at) VALUES
 ('tz','"America/New_York"',strftime('%s','now')),
 ('bed_target','"23:00"',strftime('%s','now')),
 ('bed_grace_min','15',strftime('%s','now')),
 ('winddown_min','30',strftime('%s','now')),
 ('routine_deadline','"11:00"',strftime('%s','now')),
 ('weight_unit','"kg"',strftime('%s','now')),
 ('session_autostop_h','6',strftime('%s','now')),
 ('min_sleep_h','3',strftime('%s','now'));

INSERT OR IGNORE INTO routine_items(id,name,sort,est_minutes,category,updated_at) VALUES
 ('shower','Shower',1,15,'routine',strftime('%s','now')),
 ('run','Morning run',2,30,'workout',strftime('%s','now')),
 ('stretch','Morning stretch',3,10,'routine',strftime('%s','now')),
 ('shoulders','Shoulder routine',4,10,'routine',strftime('%s','now')),
 ('journal','Morning journal',5,10,'routine',strftime('%s','now'));

INSERT OR IGNORE INTO app_categories(bundle,label,category,updated_at) VALUES
 ('com.microsoft.VSCode','VS Code','code',strftime('%s','now')),
 ('com.apple.dt.Xcode','Xcode','code',strftime('%s','now')),
 ('com.apple.Terminal','Terminal','code',strftime('%s','now')),
 ('com.googlecode.iterm2','iTerm','code',strftime('%s','now')),
 ('com.todesktop.230313mzl4w4u92','Cursor','code',strftime('%s','now')),
 ('dev.warp.Warp-Stable','Warp','code',strftime('%s','now')),
 ('com.apple.Safari','Safari','browse',strftime('%s','now')),
 ('com.google.Chrome','Chrome','browse',strftime('%s','now')),
 ('company.thebrowser.Browser','Arc','browse',strftime('%s','now')),
 ('org.mozilla.firefox','Firefox','browse',strftime('%s','now')),
 ('com.apple.MobileSMS','Messages','comms',strftime('%s','now')),
 ('com.apple.mail','Mail','comms',strftime('%s','now')),
 ('com.tinyspeck.slackmacgap','Slack','comms',strftime('%s','now')),
 ('com.hnc.Discord','Discord','comms',strftime('%s','now')),
 ('us.zoom.xos','Zoom','comms',strftime('%s','now')),
 ('com.apple.FaceTime','FaceTime','comms',strftime('%s','now')),
 ('com.spotify.client','Spotify','media',strftime('%s','now')),
 ('com.apple.Music','Music','media',strftime('%s','now')),
 ('com.apple.TV','TV','media',strftime('%s','now')),
 ('com.apple.Notes','Notes','docs',strftime('%s','now')),
 ('md.obsidian','Obsidian','docs',strftime('%s','now')),
 ('notion.id','Notion','docs',strftime('%s','now')),
 ('com.apple.iCal','Calendar','docs',strftime('%s','now')),
 ('com.apple.Preview','Preview','docs',strftime('%s','now')),
 ('com.apple.finder','Finder','other',strftime('%s','now'));
```

## API
- POST /api/tap [shortcut | app | mac] — Single ingest point for every NFC/Shortcut/in-app tap. Routes by item: routine slug -> routine_checks (INSERT OR IGNORE per item+day; also sets wake_ts on last night if missing, source 'routine'); 'bed' -> sleep_nights upsert (sleep_day = local date if hour>=12 else date-1; latest tap wins while wake_ts is NULL, taps <120 s apart are duplicates; late_min computed); 'wake' -> earliest explicit wake wins, explicit overrides inferred; 'study' / 'workout' -> toggle: no open session => start (project = body.project_id ?? settings.default_project_id ?? last used), open session younger than 90 s => duplicate, else stop; 'study_start'/'study_stop'/'workout_start'/'workout_stop' are the non-toggle forms; 'app_open' (PWA on launch 04:00-12:00) => inferred wake if none. Always appends to events, inserts dirty_days, updates automation_health. Returns a short plain-text message the Shortcut can show. | {item:'shower'|'run'|'stretch'|'shoulders'|'journal'|'bed'|'wake'|'study'|'workout'|'study_start'|'study_stop'|'workout_start'|'workout_stop'|'app_open', ts?: ISO-8601 or unix (default server now; app role may backdate up to 7 days, others +-24h), src?: 'nfc'|'alarm'|'app', project_id?, id?: client uuid} -> 201/200 {ok, item, day, result:'created'|'duplicate'|'started'|'stopped', message:'Shower done (3/5)', session_id?, late_min?, streak?}
- POST /api/screentime [mac | app] — Bulk upsert of Mac app intervals (launchd script) or iPhone hourly totals (Claude Code from a screenshot, or Biome import later). Batches INSERT OR REPLACE via env.DB.batch in chunks of 100; unknown bundles are inserted into app_categories with category NULL and seen_seconds accumulated; every local day touched is marked dirty; automation_health.mac updated. Returns the max end_ts accepted as the new watermark. | {device:'mac'|'iphone', generated_at, intervals?:[[bundle,start_ts,end_ts],...] (max 5000), hours?:[{hour_start, item:'category:Social'|'app:Instagram'|'total', seconds, granularity:'hour'|'day'}], apps?:[{bundle,label}], source?:'knowledgec'|'screenshot'|'biome'} -> {ok, inserted, watermark}
- POST /api/foods [app] — Create a food (manual label entry in the app, or Claude Code from a label photo). Dedupes on (source, source_id) and, when source_id is absent, on lower(name)+lower(brand); returns the existing id with created:false in that case. Validates the 4/4/9 identity and returns a warning flag instead of rejecting. | {id?, name, brand?, source:'label'|'off'|'usda'|'claude', source_id?, kcal_100, protein_100, carb_100, fat_100, fiber_100?, sugar_100?, serving_g?, serving_text?, label_json?} -> {id, created, atwater_warning?}
- GET /api/foods [app] — Search the user's own food catalog (recent-first, LIKE on name/brand) for the meal picker; OFF/USDA lookups run in the browser, not here. | ?q=&limit=30 -> [{food}]
- PUT /api/foods/:id [app] — Edit or soft-delete (deleted_at) a food; last-writer-wins by updated_at. | {...food fields, updated_at} -> {ok}
- GET /api/meals [app] — Presaved meals with items and computed totals, ordered by last_used_at, for the one-tap meal chips. | -> [{meal, items:[{food_id, grams, name}], totals:{kcal,protein_g,carb_g,fat_g}, total_g}]
- POST /api/meals [app] — Create or replace a presaved meal (recipe) including its items in one transaction; also used by 'Save today's lunch as a meal'. | {id?, name, note?, items:[{food_id, grams}]} -> {id}
- PUT /api/meals/:id [app] — Rename, change items, or soft-delete a meal. | {name?, note?, items?, deleted?:true} -> {ok}
- POST /api/food-log [app] — Log a food (grams) or a presaved meal (scale) or an inline one-off food; the Worker computes the snapshot totals (per100 x grams / 100, or meal totals x scale), bumps use_count/last_used_at, marks the day dirty. Client id makes retries idempotent. | {id, ts?, food_id?|meal_id?|food?:{inline food}, grams?|scale?, source:'app'|'claude'} -> {entry}
- GET /api/food-log [app] — Entries for a day plus day totals and the applicable targets (Meals screen and Today ring). | ?day=YYYY-MM-DD -> {entries:[...], totals:{kcal,protein_g,carb_g,fat_g,fiber_g,sugar_g}, targets:{...}}
- PUT /api/food-log/:id [app] — Edit grams/scale/time (totals recomputed) or soft-delete an entry. | {grams?|scale?, ts?, deleted?:true} -> {entry}
- PUT /api/targets [app] — Set nutrition targets effective from a date (history preserved). GET /api/bootstrap returns all rows. | {effective_from, kcal, protein_g, carb_g, fat_g} -> {ok}
- POST /api/exercises [app] — Create/edit/soft-delete exercises (PUT /api/exercises/:id for edits). | {id?, name, muscle?, load_type?} -> {id}
- GET /api/exercises/:id/history [app] — Everything the workout screen needs for one exercise: last session's sets (prefill), per-session best set, e1RM (Epley), total volume, plus the series for the progress chart. | ?limit=30 -> {last:{session_id, day, sets:[{set_no,reps,weight}]}, series:[{day, session_id, best:{reps,weight,e1rm}, volume, sets:n}], pr:{...}}
- POST /api/workouts [app] — Start a session (or create a completed one with started_at/ended_at). If an open session exists it is returned instead of creating a second one. | {id?, started_at?, ended_at?, note?} -> {session}
- PATCH /api/workouts/:id [app] — Finish (ended_at), annotate, or soft-delete a session. | {ended_at?, note?, deleted?:true} -> {session}
- GET /api/workouts [app] — Past sessions with sets grouped by exercise, newest first, cursor-paged, for 'look at past sessions easily'. | ?before=<started_at>&limit=20 -> [{session, exercises:[{exercise_id,name,sets:[...]}], volume, duration_s}]
- POST /api/sets [app] — Log one set (the one-tap 'same as last time' button posts exactly this). set_no is assigned server-side per session+exercise if omitted; marks the day dirty so the workout block on the chart extends to the last set. | {id, session_id, exercise_id, reps, weight, is_warmup?, ts?, set_no?} -> {set}
- PUT /api/sets/:id [app] — Correct reps/weight or soft-delete a set. | {reps?, weight?, is_warmup?, deleted?:true} -> {set}
- POST /api/projects [app] — Create/edit/archive projects (PUT /api/projects/:id for edits). | {id?, name, color?, archived?} -> {id}
- POST /api/work-sessions [app] — Start a timer (ended_at null) or record a completed study/project session with a 'what got done' note; used by the app, the Claude Code CLI ('planner session'), and accepting a Mac-derived suggestion (source 'mac_suggest'). Refuses to open a second running timer (returns the open one). | {id, project_id, started_at, ended_at?, seconds? (alternative to ended_at), note?, source:'app'|'claude'|'mac_suggest'} -> {session}
- PATCH /api/work-sessions/:id [app] — Stop the timer, add/edit the note (clears the 'pending note' card), reassign project, or soft-delete. | {ended_at?, note?, project_id?, deleted?:true} -> {session}
- GET /api/work-sessions [app] — Sessions in a range (per day list, per-project weekly hours) and the currently running one (?running=1). | ?from=&to=&project_id=&running=1 -> [{session}]
- PUT /api/checkins/:day [app] — Save the morning (intentions, planned hours) or evening (rating, what got done, tomorrow's first task) check-in; partial update. | {morning?:{intentions:[],planned_hours}, evening?:{rating,done,tomorrow}} -> {checkin}
- GET /api/routine [app] — Routine items with today's check state and timestamps, streak of complete days, and completion heatmap for the last 8 weeks. | ?day= -> {items:[{id,name,checked_at?,source?}], done, total, streak, heatmap:[{day,done,total}]}
- DELETE /api/routine/:item/:day [app] — Un-check an item (accidental tap on the wrong sticker); only the app can do this. | -> {ok}
- PUT /api/routine-items/:id [app] — Rename/reorder/deactivate items or change est_minutes/category (Settings). | {name?, sort?, est_minutes?, category?, active?} -> {ok}
- PUT /api/sleep/:sleep_day [app] — Manually set or confirm bed/wake for a night (missed tap, or confirm the cron's inference); recomputes late_min and marks confirmed=1. | {bed_ts?, wake_ts?, confirmed?:true} -> {night, streak}
- GET /api/sleep [app] — Nights in a range with lateness, sources, streak, and unconfirmed inferences for the confirm cards and the bedtime chart. | ?from=&to= -> {nights:[...], streak, on_time_rate}
- GET /api/day/:date [app] — The 24-hour timeline: runs buildDay if the day is dirty or uncached, stores blocks_json + day_summary, returns blocks, gaps, suggestions, summary, and the compact inputs so the PWA can recompute optimistically offline. | /api/day/2026-09-28 -> {blocks:[{start,end,category,label,project_id,source,confidence,detail}], gaps:[...], suggestions:[...], summary:{...}, inputs:{...}, computed_at}
- POST /api/manual-blocks [app] — Fill an Unknown gap or override a stretch by tapping the chart; PUT/DELETE /api/manual-blocks/:id to adjust. Marks the day dirty. | {id, day, start_ts, end_ts, category, label?, project_id?} -> {block}
- GET /api/summary [app] — Spending-tracker style rollups read from day_summary only: per-day rows plus grouped sums/averages for week or month views. | ?from=&to=&group=day|week|month -> {days:[day_summary...], groups:[{key, days:n, sums:{sleep_s,...}, avg_per_day:{...}, mac_by_cat, study_by_proj, routine_rate, bed_on_time, bed_avg_late_min, workouts, sets, kcal_avg}]}
- GET /api/apps [app] — Mac apps needing categorisation (category NULL) ordered by seen_seconds, and the full mapping; PUT /api/apps/:bundle sets category and marks the last 14 days dirty. | ?uncategorised=1 -> [{bundle,label,seen_seconds,category}]; PUT {category} -> {ok}
- PUT /api/settings [app] — Update settings (tz, bed_target, grace, wind-down, deadline, weight unit, USDA key, default project). Changing bed_target recomputes late_min for future nights only. | {key:value,...} -> {settings}
- GET /api/bootstrap [app] — First-launch payload after entering the token: settings, routine_items, projects, exercises, foods (top 300 by last_used_at), meals+items, targets, app_categories, last 90 days of transactional rows, today's day payload, and the sync cursor. | -> {cursor, settings, routine_items, projects, exercises, foods, meals, targets, app_categories, routine_checks, sleep_nights, food_log, workout_sessions, sets, work_sessions, checkins, manual_blocks, day_summary, today}
- GET /api/changes [app] — Delta sync feed for the PWA outbox/pull loop: every syncable table's rows with updated_at > since (tombstones included), capped at 500 rows per table with more:true for looping. | ?since=<unix> -> {cursor, more, tables:{foods:[...], meals:[...], meal_items:[...], food_log:[...], exercises:[...], workout_sessions:[...], sets:[...], projects:[...], work_sessions:[...], routine_items:[...], routine_checks:[...], sleep_nights:[...], checkins:[...], manual_blocks:[...], app_categories:[...], nutrition_targets:[...], settings:[...], day_summary:[...]}}
- GET /api/health [app] — Automation health strip: last successful Mac push and its watermark, last NFC tap per item, last Claude Code call, last cron run, pending inferences, count of uncategorised apps. | -> {mac:{last_ok_ts,watermark,stale:boolean}, nfc:{last_ok_ts, per_item:{...}}, claude:{...}, cron:{last_ok_ts}, uncategorised:n, pending_notes:n, unconfirmed_nights:n}
- POST /api/cron/run [app] — Manually invoke the scheduled handler (dev/test and 'recompute now' in Settings). | {days?:['2026-09-27']} -> {recomputed:[...]}
- CRON scheduled: '5 * * * *' (hourly, UTC) [n/a (Worker scheduled handler)] — (1) Recompute buildDay + day_summary for every dirty day plus local today and yesterday; set final=1 for dates < today-1; clear dirty_days. (2) Sleep inference: if yesterday's sleep_night has no bed_ts and local time >= 04:00, infer bed_ts = last activity (max of last Mac interval end, last phone hour with usage + 30 min, last app write, last session end) if it falls 20:00-04:00, bed_source 'inferred', confirmed 0; if wake_ts is NULL and local time >= 12:00, infer wake = earliest activity > bed_ts + min_sleep_h (first routine tap, first Mac interval, first phone hour, first app write). (3) Auto-stop runaway timers: work_session open > session_autostop_h -> ended_at = min(started_at + autostop, last Mac activity + 10 min), source 'auto_stop'; workout open > 3 h -> ended_at = last set ts + 5 min. (4) Recompute bed_streak and routine streak. (5) automation_health.cron.last_ok_ts. All steps are SQL aggregation plus small JS; comfortably under 10 ms. | controller.cron = '5 * * * *'; no body

## SCREENS
### Today — The one screen opened most: what is done, what is still open, and one-tap cards for anything automation could not settle.
  - Five routine tiles show checked state/time from NFC; tapping a tile POSTs /api/tap with src 'app' (same idempotent path); long-press un-checks
  - Sleep card: last night's bed time vs target, late minutes, streak; 'In bed now' button; 'Confirm ~00:12?' card when cron inferred a bedtime; 'I woke at' picker when wake is missing
  - Calorie ring + three macro bars vs target; recent meal chips (2 taps to log)
  - Running timer banner (study or workout) with elapsed derived from started_at; stop button; 'Session ended 10:42 by desk tap: what got done?' card when note is NULL
  - Morning check-in card until done (after wake), evening check-in card after 20:00
  - Automation health strip: 'Mac last pushed 4h ago', 'wake not detected', 'n new Mac apps to categorise' (tap goes to Settings > Apps)
  - Suggestions: 'Log 09:10-10:40 (VS Code) as <project>?' accept / change project / dismiss
### Meals — Log food in as few taps as possible using presaved meals; add new foods without re-checking labels.
  - Meal chips ordered by last used; tap logs at scale 1.0, long-press for scale/grams
  - Food picker: local catalog search (recent first) -> grams input with serving presets (1 serving, last amount, 100 g)
  - Add food: tabs Scan (still photo via <input capture> -> barcode-detector ponyfill -> OFF v3 lookup gated on energy-kcal_100g -> USDA Branded fallback by GTIN), Search (USDA /foods/search, ids 1008/1003/1005/1004/1079/2000 then 1063, de-duplicated), Label (type per-serving values + serving grams; per-100 computed; 4/4/9 warning shown, not blocking)
  - Day list with edit/delete and totals; 'Save today's meals as a preset'
  - Targets editor with effective-from date
### Workout — Log every set with one tap by pre-filling from the last session; browse and chart past sessions.
  - Start session (or it is already open from the gym sticker); exercise picker ordered by last used
  - Per exercise: ghost rows of last session's sets; 'Log set' button pre-filled with last reps/weight, +/- steppers; each tap POSTs /api/sets
  - Finish session; note field optional
  - History tab: sessions list newest first with per-exercise sets and volume (GET /api/workouts)
  - Progress tab: per exercise line chart of best set (e1RM) and volume per session (GET /api/exercises/:id/history)
### Projects — Study/side-project sessions with duration and a 'what got done' note, started by timer, sticker, terminal or Mac-derived suggestion.
  - Start timer (project chip) with Wake Lock while visible; stop asks for the note
  - Manual entry: project, duration (or start/end), note
  - Sessions grouped by day; pending-note badge; reassign project
  - Per-project hours this week/month chart; accept/dismiss Mac-derived session suggestions
### Day — The 24-hour timeline: what the day's hours went to, with Unknown visible and fillable.
  - Vertical 24-h column with colored blocks (sleep, workout, study by project, routine, mac by app category, phone hatched, other, unknown striped); now marker; swipe/arrow between days
  - Tap an unknown gap -> sheet with category chips (eating, chores, social, commute, leisure, study+project, sleep) and 'extend previous block'; POST /api/manual-blocks
  - Tap a block -> details (Mac app breakdown, session note, sets), edit/delete for manual blocks
  - Toggle a Mac/phone sub-lane to see telemetry under logged blocks
  - Legend with seconds per category for the day
### Reports — Spending-tracker style weekly and monthly views of time, routine, sleep, workouts, and calories.
  - Week/Month toggle and range navigation (GET /api/summary?group=)
  - Stacked bars per day by category; donut of category share; averages per day
  - Routine completion heatmap; bedtime line vs target with on-time nights; workouts count and sets; kcal vs target line
  - Mac time by app category and study time by project breakdowns
### Check-ins — Beginning-of-day and end-of-day reflection with minimal typing (also surfaced as Today cards).
  - Morning: up to three intentions, planned work hours
  - Evening: rating 1-5, 'what got done' (pre-filled with today's session notes), tomorrow's first task
  - History list by day
### Settings — One-time setup and the levers that drive automation.
  - APP token entry (localStorage), server URL, sign-out (clears token and IDB)
  - Timezone, bedtime target, grace minutes, wind-down minutes (also shows the exact Time-of-Day values to put in the two Shortcuts automations), routine deadline, weight unit, default project
  - Routine items editor (name, order, est_minutes, category)
  - Apps triage: uncategorised Mac bundles with names and seen time, one-tap category chips
  - Automation setup guide: copyable URL and JSON body for the 'Planner Tap' Shortcut, list of automations, Mac script install steps, health details
  - Data: 'Recompute today', backup instructions (wrangler d1 export), token rotation notes

## OFFLINE/SYNC
IndexedDB (via idb) holds four stores: 'tables' (a mirror of every syncable table: catalogs in full, transactional rows for the last 90 days), 'days' (cached /api/day payloads keyed by date), 'outbox' (ordered mutations {id, method, path, body, created_at, attempts}), and 'meta' (sync cursor). Every UI write applies to IDB first (client UUID id, updated_at = now), appends to the outbox, and triggers a flush; flush runs on launch, on visibilitychange to visible, on the online event, after each write, and every 60 s while visible. Flush is sequential in order, stops on network failure, retries later; a 4xx other than 401 is surfaced as an error card and the mutation is dropped (401 sends the user to Settings). Every POST/PUT carries the client id, and the Worker uses INSERT OR IGNORE or ON CONFLICT DO UPDATE ... WHERE excluded.updated_at > updated_at, so retries and double-sends are harmless; /api/tap is idempotent by its own rules. After a flush the app pulls GET /api/changes?since=cursor, applies rows (deleted_at rows become tombstones), stores the new cursor, and invalidates cached days that the changed rows touch; today's timeline is recomputed locally with the shared buildDay on cached inputs plus outbox entries so the chart reflects a tap before the server confirms. First login uses /api/bootstrap. The service worker (vite-plugin-pwa, generateSW) precaches the app shell and icons with navigateFallback to index.html and never caches /api; navigator.storage.persist() is called once at launch (auto-granted for Home Screen apps). Timers store only started_at; the UI derives elapsed from Date.now() on requestAnimationFrame and on visibilitychange/pageshow/focus, holding a Screen Wake Lock while a timer view is visible and re-requesting it on visibilitychange. The Mac uses the same PWA in Safari or Add to Dock: same origin, separate IndexedDB, converging through the changes feed. Conflicts are last-writer-wins by updated_at, which is enough for a single user; the one designed conflict (a session started by an NFC tap on the server while the phone app is offline showing no timer) resolves on the next pull because the server row wins and the timer UI adopts it.

## NFC/SHORTCUTS
ONE shortcut, 'Planner Tap': input = text. Action 'Get Contents of URL' -> https://planner.<subdomain>.workers.dev/api/tap, Method POST, Headers Authorization: Bearer <SHORTCUT_TOKEN>, Request Body JSON {item: Shortcut Input, ts: Current Date formatted ISO 8601, src: 'nfc'}. Optional: 'Get Dictionary Value' message -> 'Show Notification' so the banner reads 'Shower done (3/5)' or 'Study started (project X)' or 'In bed 23:12, 12 min late, streak 4'. Run it once manually and choose Always Allow. Automations (Shortcuts > Automation > +, each 'Run Immediately', Notify When Run off): NFC x5 for shower/run/stretch/shoulders/journal (plain NTAG213 stickers at shower door, shoe shelf, mat, band hook, journal) each running Planner Tap with input = the slug; NFC 'bed' on the nightstand; NFC 'study' on the desk (toggle: first tap starts a session on the default/last project, second tap stops it and the app asks for the note next time it opens); optional NFC 'workout' on the rack or gym bag (toggle). Alarm > Is Stopped (Sleep/Wake Up alarm or any) -> Planner Tap with input 'wake' and src 'alarm' — the phone is already in hand, no extra gesture; fallback Sleep automation 'Waking Up'. Two Time-of-Day automations without network: at bed_target minus winddown_min 'Wind down: 30 min to bed' and at bed_target 'Tap the nightstand sticker when you are in bed' (Settings shows the exact times to enter; edit the automations when the target changes). Recreate automations on a new iPhone (they do not sync) and re-check 'Run Immediately' after iOS updates. Physical gesture: raise to wake (Face ID), touch the top edge to the sticker ~1 s; nothing opens. Idempotency on the server: routine = PRIMARY KEY (item_id, day) with INSERT OR IGNORE, duplicate returns 200 result 'duplicate'; bed = one sleep_nights row per sleep_day (noon cutoff), taps within 120 s are duplicates, a later tap before 04:00 with no wake replaces bed_ts (first_bed_ts kept); wake = earliest explicit wins, later explicit ignored, explicit overrides any inference; study/workout toggles ignore a second tap within 90 s of the start so a double tap cannot immediately stop a session; every call is logged in events with its result. In-app fallback: the Today tiles, 'In bed now', 'I woke at', start/stop buttons post the same items with src 'app' through the outbox, so nothing depends on NFC working. Bedtime logic: target_bed_ts = bed_target on sleep_day in settings.tz; late_min = (bed_ts - target_bed_ts)/60; night is 'on time' when late_min <= bed_grace_min; streak = consecutive nights (ending at the last completed night) that are on time and confirmed (explicit tap or user-confirmed inference); a missing tap produces a cron inference (last activity on Mac/phone/app + 30 min) shown as a confirm card, and an unconfirmed night breaks the streak until confirmed or edited, which is the nudge to keep tapping. Wake logic precedence: alarm/nfc/app explicit > first routine tap > app_open (PWA launch 04:00-12:00) > first Mac interval > cron inference; the accepted wake must be >= bed_ts + min_sleep_h, otherwise it is ignored and left for the app to fix.

## MAC SCRIPT
~/bin/screentime_push.py, run by /usr/bin/python3 (Apple's, stdlib only: sqlite3, shutil, tempfile, json, urllib.request, subprocess, plistlib, os, time). Reads: copies ~/Library/Application Support/Knowledge/knowledgeC.db plus -wal and -shm to a mkdtemp dir, opens the copy with file:...?mode=ro (never immutable=1 on the live file), runs SELECT ZOBJECT.ZVALUESTRING bundle, ZOBJECT.ZSTARTDATE+978307200 s, ZOBJECT.ZENDDATE+978307200 e FROM ZOBJECT LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE=ZSOURCE.Z_PK WHERE ZOBJECT.ZSTREAMNAME='/app/usage' AND ZSOURCE.ZDEVICEID IS NULL AND ZOBJECT.ZENDDATE > (watermark - 600) - 978307200 ORDER BY s; the RMAdminStore query is omitted (EPERM even with FDA on macOS 26.3+). Bucketing: skip bundles com.apple.loginwindow, com.apple.ScreenSaver.Engine and any interval < 5 s; merge consecutive intervals of the same bundle when the gap <= 60 s; drop merged intervals < 10 s; clip to [watermark - 600, now - 60] so the still-open interval is sent next run; typical output 100-400 intervals per hour of use. App names: for new bundles, one LaunchServices-free lookup by scanning /Applications and ~/Applications Info.plist files (CFBundleIdentifier -> CFBundleDisplayName/CFBundleName) cached in ~/.config/planner/apps.json, sent as apps:[{bundle,label}] so the triage screen shows readable names. Posts: one POST to $PLANNER_URL/api/screentime with Authorization: Bearer <MAC_TOKEN>, body {device:'mac', host, generated_at, source:'knowledgec', intervals:[[bundle,start,end],...], apps:[...]}, chunked at 2000 intervals per request, timeout 30 s; on 2xx writes ~/.config/planner/mac_watermark = response.watermark (only on success, so a failed push is resent and the server-side upsert on (device,start_ts,bundle) keeps it idempotent); rmtree the temp dir in finally. Logs to ~/Library/Logs/screentime-push.log (one line per run: rows, watermark, status). Schedule: LaunchAgent ~/Library/LaunchAgents/com.pranav.screentime-push.plist with ProgramArguments [/usr/bin/python3, /Users/pranavgadiraju/bin/screentime_push.py], StartCalendarInterval Minute 7 (hourly at :07), RunAtLoad true, EnvironmentVariables PLANNER_URL and PATH=/usr/bin:/bin:/usr/sbin:/sbin, StandardOut/ErrorPath under ~/Library/Logs; load with launchctl bootstrap gui/$(id -u) <plist>, test with launchctl kickstart -k gui/$(id -u)/com.pranav.screentime-push. Security: Full Disk Access for the exact binary /usr/bin/python3 (drag it into System Settings > Privacy & Security > Full Disk Access; the '+' picker was broken for bare binaries on 26.1-26.2, so verify with the TCC.db query from an FDA Terminal: client '/usr/bin/python3' auth_value 2), MAC_TOKEN stored once with security add-generic-password -a "$USER" -s planner-mac-token -w and read with security find-generic-password -s planner-mac-token -w (fallback: chmod 600 ~/.config/planner/token), plist 0644 with no secrets, script 0700, URL pinned to the Worker hostname over HTTPS, and the token is write-only on the server so a leak can only insert screen rows until rotated with wrangler secret put MAC_TOKEN. Cost: ~1-4k D1 row writes/day. Stretch (later milestone): the same script gains a second source, aw-import-screentime decoding ~/Library/Biome/streams/restricted/App.InFocus/remote/<device_id>/ for iPhone hourly rows (device 'iphone', source 'biome'), requiring Share Across Devices and accepting multi-hour lag.

## DAY CHART
Definitions: D0 = local midnight of the date in settings.tz (via Intl; 23/25 h on DST days), D1 = next local midnight, now = server time. buildDay(date, inputs) is a pure TypeScript function in packages/core used by GET /api/day/:date, by cron, and by the PWA on cached inputs plus outbox for optimistic display. Inputs: sleep_nights with sleep_day in (date-1, date); workout_sessions, work_sessions, manual_blocks overlapping [D0,D1); routine_checks for date joined to routine_items (est_minutes, category); screen_intervals device 'mac' overlapping; screen_hours device 'iphone' granularity 'hour' within the day; app_categories; food_log totals and the applicable nutrition_targets. Step 1, candidate segments with priorities: manual_blocks 100; sleep 90: for each night [bed_ts, wake_ts], where a missing wake_ts becomes (date is today and now < bed_ts + 10 h ? now : bed_ts + 8 h) flagged confidence 'estimated', and a night with no bed_ts contributes nothing; workout 80: [started_at, ended_at ?? last set ts + 300 s ?? min(now, started_at + 3 h)]; study 70: [started_at, ended_at ?? now] labelled with project; routine 60: [tap_ts, min(tap_ts + est_minutes*60, next routine tap of the day, next start of any segment with priority >= 70)] with category from routine_items.category (so the run draws as workout); mac 40: intervals mapped through app_categories to code/browse/comms/media/docs/other (NULL -> 'mac_other'), adjacent same-category intervals merged when gap <= 60 s; phone 20 is applied in step 4. Step 2: clip every segment to [D0,D1); for today also clip to now; [now,D1) is 'future', never 'unknown'. Step 3, sweep: sort all boundaries, and for each elementary slice choose the covering segment with the highest priority (ties: later start wins). Mac segments beneath a winning study/workout/routine/manual block are attached to that block as detail (app breakdown) and counted in mac_by_cat_json but not in mac_s; uncovered Mac slices become 'mac' blocks. Step 4, phone fill: for each local hour with phone seconds p > 0, walk that hour's still-unknown slices from the hour start and convert them to 'phone' (confidence 'approx') until p is consumed; any leftover is summary.phone_overlap_s (phone used while another block was active) and is never drawn. Step 5: merge adjacent slices with identical (category, label, project_id); absorb unknown slices shorter than 120 s into the preceding block; whatever remains is 'unknown' and rendered striped. Step 6, outputs: blocks [{start, end, category, label, project_id, source, confidence, detail}]; gaps = unknown blocks >= 15 min, each carrying the Mac/phone evidence inside it for the fill sheet; suggestions: (a) any stretch not covered by a study session where Mac code/docs categories cover >= 25 min of a rolling 30-min window -> 'Log 09:10-10:40 as <project>?' with project = the most-used project in the same weekday+hour over the last 4 weeks, else settings.default_project_id (accepting POSTs a work_session with source 'mac_suggest'); (b) 'confirm inferred bedtime' when bed_source is 'inferred' and confirmed=0; (c) 'wake not recorded' when the sleep end is estimated. Summary: seconds per category (sleep, workout, study with per-project map, routine, mac with per-app-category map, phone, other, unknown), kcal/protein/carb/fat vs target, routine done/total, bed_late_min, streak, workout sets. Precedence rationale: explicit user intent (manual) beats bodily state (sleep) beats logged activities (workout, study, routine) beats passive telemetry (Mac) beats coarse estimates (phone). Persistence: every write that carries a day (tap, set, session, food-log, screentime, manual block, app category change) inserts dirty_days; GET /api/day recomputes when the day is dirty or uncached and writes day_summary including blocks_json; the hourly cron recomputes all dirty days plus local today and yesterday, sets final=1 for dates < today-1, and clears dirty_days; final days are served from cache until dirtied again, which keeps per-request CPU to a single day's sweep (hundreds of slices, well under 10 ms). Weekly and monthly rollups: GET /api/summary?from&to&group=week|month reads only day_summary (<= 31 rows per month): per-group sums and per-day averages of every *_s column, stacked per-day series, mac_by_cat and study_by_proj merged by key, routine completion rate, on-time nights and mean lateness, workout count and total sets, average kcal vs target; weeks run Monday-Sunday in local time; a day with no row at all is treated as 24 h unknown so averages stay honest.

## CLAUDE CODE HELPERS
The repo contains CLAUDE.md and scripts/planner.mjs (Node 20+, no dependencies) so Claude Code becomes the typing surrogate. The CLI reads the base URL from .planner.json (non-secret) and the APP_TOKEN from the login Keychain (security find-generic-password -s planner-app-token -w; the Mac is the user's trusted shell, so it gets the read/write app role, while the unattended launchd script keeps the write-only MAC_TOKEN); tokens never appear in CLAUDE.md, the repo, or chat. Subcommands: 'food add <json|->' -> POST /api/foods and prints id + per-100 g numbers; 'eat <food-id|name> <grams> [--at HH:MM]' and 'eat-meal <meal-name> [scale]' -> POST /api/food-log; 'session <project> <duration|HH:MM-HH:MM> "<note>"' -> POST /api/work-sessions with source 'claude' (terminal-native end-of-session logging); 'phone-hours <json>' -> POST /api/screentime device 'iphone' source 'screenshot'; 'tap <item>' -> POST /api/tap src 'app'; 'day [date]' and 'week' -> GET /api/day and /api/summary printed as compact JSON for review prompts. CLAUDE.md instructs Claude Code: (1) Nutrition label photo pasted: extract serving size in grams (ask if only a household measure is printed and no gram weight), per-serving kcal, protein, carbs, fat, fiber, sugar; compute per-100 g = per-serving x 100 / serving_g; run the Atwater check |4P + 4C + 9F - kcal| <= 15% of kcal (or 25 kcal at small servings) and mention a mismatch; call 'planner food add' with source 'label', label_json holding the raw printed numbers; echo the stored numbers. (2) iPhone Screen Time screenshot (Settings > Screen Time > See All App & Website Activity, Day view): extract the date, daily total, the 24 hourly bars as minutes with dominant category color, Most Used apps with h/m, pickups; call 'planner phone-hours' with hours:[{h, minutes, category}] (converted to hour_start in settings.tz, item 'category:<name>', granularity 'hour') and apps:[{name, minutes}] (item 'app:<name>', granularity 'day'); grey/unattributed time is left unknown, never guessed. (3) 'I ate 180 g of X' or 'log 2 h on projX, did Y' -> the matching subcommand, then a one-line confirmation. (4) Weekly review: run 'planner week' and summarise. Endpoint contract (also in CLAUDE.md so no guessing): POST /api/foods {name, brand?, source, source_id?, kcal_100, protein_100, carb_100, fat_100, fiber_100?, sugar_100?, serving_g?, serving_text?, label_json?}; POST /api/food-log {id, ts?, food_id|meal_id|food, grams|scale, source:'claude'}; POST /api/screentime {device, hours:[...], source:'screenshot'}; POST /api/work-sessions {id, project_id, started_at, seconds|ended_at, note, source:'claude'}. Every helper call lands in events/automation_health.claude so the app's health strip shows 'Claude added Greek yogurt at 13:02'.

## MILESTONES
- **M1 Taps land (routine + bedtime)**: Worker with static assets + D1 (schema.sql applied) + three secrets; POST /api/tap with all routing rules, events log, GET /api/routine, GET/PUT /api/sleep; a minimal Today page (routine tiles, In bed now, I woke at) that stores the token in localStorage; the 'Planner Tap' Shortcut and NFC automations for five routine stickers + nightstand + Alarm-Is-Stopped 'wake'; two Time-of-Day wind-down/bedtime notifications.
  - verify: curl POST /api/tap {item:'shower'} twice returns 201 created then 200 duplicate; tapping a sticker with the phone shows the check in the page within one reload; bed tap at 23:12 with target 23:00 shows late 12 min; wrangler d1 execute 'select item,source,result from events' shows source nfc; the alarm automation records wake_ts.
- **M2 Installable, offline, two devices**: Manifest + service worker (vite-plugin-pwa), IndexedDB mirror, outbox, GET /api/bootstrap and /api/changes, Settings screen (token, tz, bed target), Add to Home Screen on iPhone and Add to Dock on Mac.
  - verify: Airplane mode: tap a routine tile, quit, go online, reopen: exactly one routine_checks row on the server; a check made on the Mac appears on the phone after foreground; Lighthouse installability passes; token absent -> Settings shown.
- **M3 Meals**: foods/meals/food-log/targets endpoints and the Meals screen: presaved meal chips, local catalog search, USDA name search, barcode via still photo + barcode-detector + OFF v3 (gated on energy-kcal_100g) with USDA GTIN fallback, manual label entry with per-100 math and 4/4/9 warning, Today calorie ring; CLAUDE.md + scripts/planner.mjs 'food add' and 'eat'.
  - verify: Scan a known barcode -> per-100 g values shown and editable before saving; log a presaved meal in two taps and the ring updates offline; paste a label photo into Claude Code -> food appears in the app with matching numbers; a label with wrong kcal triggers the Atwater warning but still saves.
- **M4 Workouts**: exercises/workouts/sets endpoints, Workout screen with ghost rows and one-tap 'same as last' set logging, History list, Progress charts (e1RM and volume), optional 'workout' NFC toggle.
  - verify: Second session of the same exercise pre-fills the previous reps/weight; one tap creates a sets row with correct set_no; progress chart shows two points after two sessions; two quick taps on the workout sticker start exactly one session and the third stops it.
- **M5 Projects, study sessions, check-ins**: projects/work-sessions/checkins endpoints, Projects screen (timer with Wake Lock, manual entry, notes), desk 'study' NFC toggle, pending-note card on Today, morning/evening check-in cards, CLI 'session'.
  - verify: Desk tap starts a session (message names the project), second tap after 5 min stops it, app shows the 'what got done?' card and saving clears it; timer survives screen lock and shows correct elapsed on return; 'planner session projX 2h "did Y"' appears in the day list.
- **M6 Mac screen-time pipeline**: screentime_push.py, Keychain token, Full Disk Access for /usr/bin/python3, LaunchAgent, POST /api/screentime with batched upserts and app_categories triage, Settings > Apps screen, health strip on Today.
  - verify: TCC.db query shows /usr/bin/python3 with auth_value 2; first run log reports N intervals and a watermark, second run reports only new ones; screen_intervals rows exist for the last hour; uncategorised list shows readable app names; killing the agent for 3 h makes the health strip say stale.
- **M7 Day chart and reports**: packages/core buildDay, GET /api/day with dirty-day caching, manual_blocks gap filling, Mac-derived session suggestions, hourly cron with day_summary/final, GET /api/summary, Day and Reports screens, CLI 'phone-hours' for iPhone screenshots.
  - verify: Yesterday's chart shows sleep from the bed tap to the alarm wake, the run as workout, study sessions labelled by project, Mac blocks by category, and striped unknown; tapping a gap and choosing 'eating' persists and survives reload; POST /api/cron/run writes day_summary whose category seconds sum to 86400 minus future; week view totals equal the sum of its days; pasting a Screen Time screenshot fills hatched phone blocks.
- **M8 Hardening and stretch**: Cron inferences with confirm cards (bedtime, wake), streaks, auto-stop of runaway timers, weekly wrangler d1 export backup via launchd, token rotation runbook, iOS update checklist (Run Immediately re-check), optional Biome iPhone import via aw-import-screentime.
  - verify: Skip the bed tap one night: next morning Today shows 'Confirm bedtime ~00:12?' with the last Mac activity + 30 min, confirming continues the streak; leave a study timer running overnight: cron closes it at last Mac activity + 10 min with source auto_stop; backup file appears weekly; rotating SHORTCUT_TOKEN breaks only the Shortcut until updated.

## RISKS
- knowledgeC.db '/app/usage' could be dropped or vaulted in a future macOS release like RMAdminStore was in 26.3; mitigation: the ingest contract is source-agnostic, ActivityWatch (localhost:5600, no FDA) is a drop-in replacement for the Mac source.
- Full Disk Access for a bare /usr/bin/python3 was flaky on macOS 26.1-26.2; if the grant does not stick on 26.6.2, wrap the script in a signed .app bundle (Apple DTS recommendation) or run it from an FDA-granted Terminal via a scheduled shell.
- Whether an NFC automation fires on a locked-but-awake phone is unsettled; the design assumes raise-to-wake + Face ID + tap, and iOS updates have flipped 'Run Immediately' back to 'Ask Before Running', so the health strip flags days with zero taps.
- Shortcuts 'Get Contents of URL' has an undocumented ~25 s timeout; the Worker answers /api/tap in a few ms, but a D1 outage would silently drop taps: the in-app tiles and events audit are the fallback.
- 10 ms CPU per invocation: a day with thousands of un-merged Mac intervals could push buildDay over budget; the script merges and caps intervals, the Worker caps intervals per day at 3000 (oldest merged coarser), and computation is cached per day.
- D1 100k row writes/day includes index writes; a chatty Mac script re-sending 26 h windows could burn 60k+/day, which is why the watermark only sends new intervals (~1-4k writes/day).
- Static APP_TOKEN in localStorage on a lost phone exposes the data; rotate with wrangler secret put APP_TOKEN, and the token never appears in the served HTML/JS.
- USDA API key lives in settings and is used from the browser; keep the repo private (USDA deactivates keys found online) and never commit .planner.json with a key.
- Open Food Facts data is crowdsourced and contains placeholder products; gating on energy-kcal_100g and showing values before saving mitigates, and OFF search is not used at all.
- iPhone usage has no reliable automatic source: the Biome import depends on Share Across Devices sync lag and an undocumented SEGB format; the screenshot-to-Claude path is honest but manual, so phone time will often show as unknown.
- Timezone edge cases: sleep across DST changes and travel; day boundaries are computed with Intl per date, but a tz change in Settings does not rewrite historical day values.
- Cloudflare free-tier terms shift (D1 hard enforcement started 2026-09-01); if limits are hit, D1 errors until 00:00 UTC, so the outbox and Mac watermark must retry rather than drop.
- Inferred bedtimes/wakes can be wrong (late-night Mac use by someone else, phone used in bed); they are always marked unconfirmed and break streaks until confirmed, so errors surface rather than hide.
- Camera behaviour in installed web apps regresses across iOS point releases; the still-photo capture path avoids getUserMedia, but if capture also breaks, the manual label path and Claude Code remain.

## OPEN QUESTIONS
- Timezone to seed (assumed America/New_York from the research hint) and whether you travel enough to want per-day tz recorded.
- Bedtime target and grace minutes (assumed 23:00 and 15 min), and wind-down lead time (assumed 30 min).
- Does a routine sticker tap mean 'starting' or 'finished'? The chart assumes tap = start and draws est_minutes forward; if you tap when done, blocks should be drawn backward.
- Do you use an iPhone alarm every morning? If not, wake detection falls back to the first routine tap or app open, which is later than the real wake.
- Where do you lift: home or gym? That decides whether a fixed 'workout' sticker makes sense or whether starting from the app is fine.
- Should the desk 'study' sticker default to the last-used project or a fixed default, and should the 'what got done' note be asked at stop time or bundled into the evening check-in?
- kg or lb for weights, and do you want RPE on sets (not in the schema by default)?
- Is the Mac asleep at night and awake most of the day? This affects how trustworthy 'last Mac activity' is as a bedtime inference.
- Are you willing to grant Full Disk Access to /usr/bin/python3 on your Mac, or would you prefer installing ActivityWatch (no FDA, adds window titles) as the Mac source instead?
- Will you sign up for a free USDA FoodData Central API key (fdc.nal.usda.gov/api-key-signup) for name search? Without it only DEMO_KEY (tiny limits) works.
- Do you want the optional iPhone Biome import (Share Across Devices on, aw-import-screentime) attempted in M8, or is the screenshot-to-Claude path enough?
- Is a static token typed once into the PWA acceptable as the only login, given Cloudflare Access may ask for a card at Zero Trust onboarding?


####################################################################################################
# DESIGN: In-the-moment UX: every phone screen is optimized for the exact moment it is use
####################################################################################################

## OVERVIEW
One repo (planner/) deploys as a single Cloudflare Worker on the free plan: /api/* is a hand-rolled TypeScript router over D1, everything else is the Vite-built PWA served from the Worker's static-assets binding (run_worker_first: ["/api/*"], not_found_handling: single-page-application). The iPhone runs the installed home-screen PWA; the Mac runs the same PWA in Safari (File > Add to Dock, two-column layout at >= 900 px) plus two headless writers: an hourly launchd Python script that ships knowledgeC.db focus intervals with MAC_TOKEN, and a tiny `planner` Node CLI that Claude Code calls after reading a nutrition-label photo or an iPhone Screen Time screenshot. The PWA is local-first: every screen reads from IndexedDB (Dexie), every write goes to IndexedDB plus an outbox first and then to POST /api/sync, and a seq-cursor pull brings other devices' rows back, so a set logged in a basement gym or a session ended on the Mac shows up everywhere without any screen ever blocking on the network. Anything that must fire while the phone is closed never touches the PWA (iOS has no Background Sync and no deep link into an installed web app): six NFC stickers (five routine stations plus the nightstand) each run a Shortcuts NFC automation that silently POSTs {item} to /api/tap with the write-only SHORTCUT_TOKEN, the wind-down reminder is a Shortcuts Time-of-Day automation, and the app simply shows the result the next time it opens. The 24-hour day chart is computed server-side from eight sources by a fixed precedence (manual blocks > sleep > workout > study > routine > Mac intervals > phone hours > Unknown) into 1440 minute slots; the same function feeds day_summary rows that a daily cron (09:00 UTC) caches for the week/month spending-style views, and Unknown gaps are first-class objects the user fills with one tap. Screens are built around the moment: the Active Workout screen logs a set with one tap using last session's weight and reps, the Food tab logs a presaved meal in two taps, ending a study session is End plus one auto-focused text field, and Today fits routine, sleep, running timers and the day ring above the fold on an iPhone XS. Milestone 1 (routine and bed stickers plus Today) is useful on its own from day one; each later milestone adds one tab.

## FRONTEND
TypeScript + Vite + Preact (3 kB) with @preact/signals for state and preact-iso for history routing, so the cold launch of the installed web app on an iPhone XS is well under a second and a running timer or the calorie ring re-renders without touching the rest of the tree. Persistence is Dexie (IndexedDB) with one object store per synced table plus an outbox and kv store; Dexie liveQuery feeds signals so every screen is a pure view of local data. The service worker comes from vite-plugin-pwa (Workbox generateSW: precache the shell, navigateFallback index.html, /api/* NetworkOnly, registerType autoUpdate with a "Reload for update" toast). Charts (24 h timeline, ring, stacked weekly bars, exercise progress lines, macro bars) are hand-written inline SVG components (~300 lines total) rather than a chart library, which keeps the bundle tiny, makes the timeline tappable per block, and honours prefers-color-scheme; the only lazy-loaded dependency is the barcode-detector ponyfill on the scan screen. Shared TypeScript types and the sleep/day-key helpers live in shared/ and are imported by both the Worker and the PWA, and the same responsive layout serves the Mac at >= 900 px (sidebar nav + detail pane) so there is exactly one frontend.

## SCHEMA
```sql
-- ============================================================================
-- planner/schema.sql  --  Cloudflare D1 (SQLite).  Apply with:
--   npx wrangler d1 execute planner --remote --file=schema.sql   (use --local for dev)
-- Conventions
--   * ids are client-generated UUIDv4 strings so offline writes are idempotent.
--   * every *_at / ts column is ISO-8601 UTC text 'YYYY-MM-DDTHH:MM:SS.sssZ' (sorts lexically).
--   * local_day is 'YYYY-MM-DD' in the timezone stored in settings.tz; it is computed in the
--     Worker / PWA with Intl, never with SQLite 'localtime' (Workers run in UTC).
--   * updated_at = client wall clock, used for last-writer-wins on sync.
--   * seq = server-assigned counter (sync_meta.seq), used as the incremental pull cursor.
--   * deleted_at = soft delete on every synced table; screen_*, phone_app_days, tap_log,
--     lookup_cache and day_summary are server-only and may be hard-deleted.
--   * D1 enforces FOREIGN KEY constraints by default.
-- ============================================================================

CREATE TABLE IF NOT EXISTS sync_meta (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT OR IGNORE INTO sync_meta(key, value) VALUES ('seq', 0);

-- Key/value settings, synced to the PWA like any other table.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,   -- tz | targets | bed_target | winddown_min | late_grace_min | wake_target | weight_unit
  value      TEXT NOT NULL,      -- JSON encoded
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES
  ('tz',             '"America/New_York"',                                    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('targets',        '{"kcal":2400,"protein_g":170,"carb_g":260,"fat_g":80}',  strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bed_target',     '"23:00"',                                               strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('winddown_min',   '45',                                                    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('late_grace_min', '15',                                                    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('wake_target',    '"07:00"',                                               strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('weight_unit',    '"kg"',                                                  strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE INDEX IF NOT EXISTS ix_settings_seq ON settings(seq);

-- ---------------------------------------------------------------- FOOD
CREATE TABLE IF NOT EXISTS foods (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  brand        TEXT,
  source       TEXT NOT NULL CHECK (source IN ('label','off','usda')),
  source_id    TEXT,                          -- barcode (off) | fdcId (usda) | NULL (label)
  kcal_100     REAL NOT NULL,                 -- everything is stored per 100 g
  protein_100  REAL NOT NULL DEFAULT 0,
  carb_100     REAL NOT NULL DEFAULT 0,
  fat_100      REAL NOT NULL DEFAULT 0,
  fiber_100    REAL,
  sugar_100    REAL,
  serving_g    REAL,                          -- grams of one label serving when known (default grams prompt)
  serving_text TEXT,                          -- e.g. '3/4 cup (30g)'
  label_json   TEXT,                          -- raw per-serving numbers as typed / read from the label (audit)
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_foods_source ON foods(source, source_id);
CREATE INDEX IF NOT EXISTS ix_foods_seq    ON foods(seq);

-- Presaved meals = recipes of (food, grams); totals denormalised for two-tap logging.
CREATE TABLE IF NOT EXISTS meals (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  total_g      REAL NOT NULL DEFAULT 0,       -- sum of item grams
  kcal         REAL NOT NULL DEFAULT 0,       -- totals at scale 1.0
  protein_g    REAL NOT NULL DEFAULT 0,
  carb_g       REAL NOT NULL DEFAULT 0,
  fat_g        REAL NOT NULL DEFAULT 0,
  fiber_g      REAL,
  sugar_g      REAL,
  default_slot TEXT CHECK (default_slot IN ('breakfast','lunch','dinner','snack')),
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_meals_seq ON meals(seq);

CREATE TABLE IF NOT EXISTS meal_items (
  id         TEXT PRIMARY KEY,
  meal_id    TEXT NOT NULL REFERENCES meals(id),
  food_id    TEXT NOT NULL REFERENCES foods(id),
  grams      REAL NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_meal_items_meal ON meal_items(meal_id);
CREATE INDEX IF NOT EXISTS ix_meal_items_seq  ON meal_items(seq);

-- One row per thing eaten; macros are a snapshot so later food edits never rewrite history.
CREATE TABLE IF NOT EXISTS food_log (
  id         TEXT PRIMARY KEY,
  ts         TEXT NOT NULL,
  local_day  TEXT NOT NULL,
  slot       TEXT NOT NULL CHECK (slot IN ('breakfast','lunch','dinner','snack')),
  food_id    TEXT REFERENCES foods(id),
  meal_id    TEXT REFERENCES meals(id),
  grams      REAL,                            -- when food_id
  scale      REAL,                            -- when meal_id (1.0 = whole meal)
  label      TEXT NOT NULL,                   -- display name snapshot
  kcal       REAL NOT NULL,
  protein_g  REAL NOT NULL DEFAULT 0,
  carb_g     REAL NOT NULL DEFAULT 0,
  fat_g      REAL NOT NULL DEFAULT 0,
  fiber_g    REAL,
  sugar_g    REAL,
  note       TEXT,
  source     TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','cli')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  CHECK (food_id IS NOT NULL OR meal_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_food_log_day ON food_log(local_day);
CREATE INDEX IF NOT EXISTS ix_food_log_seq ON food_log(seq);

-- ---------------------------------------------------------------- LIFTING
CREATE TABLE IF NOT EXISTS exercises (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  muscle       TEXT,                          -- chest|back|legs|shoulders|arms|core|cardio (free text)
  load_type    TEXT NOT NULL DEFAULT 'weight' CHECK (load_type IN ('weight','bodyweight')),
  weight_step  REAL NOT NULL DEFAULT 2.5,     -- stepper increment in settings.weight_unit
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_exercises_seq ON exercises(seq);

CREATE TABLE IF NOT EXISTS workouts (
  id         TEXT PRIMARY KEY,
  name       TEXT,                            -- 'Push','Pull','Legs': the next session of the same name is pre-populated from this one
  started_at TEXT NOT NULL,
  ended_at   TEXT,                            -- NULL = in progress
  local_day  TEXT NOT NULL,
  note       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_workouts_day ON workouts(local_day);
CREATE INDEX IF NOT EXISTS ix_workouts_seq ON workouts(seq);

CREATE TABLE IF NOT EXISTS sets (
  id          TEXT PRIMARY KEY,
  workout_id  TEXT NOT NULL REFERENCES workouts(id),
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  set_no      INTEGER NOT NULL,               -- 1-based within (workout, exercise)
  reps        INTEGER NOT NULL,
  weight      REAL NOT NULL DEFAULT 0,        -- in settings.weight_unit; 0 for bodyweight
  is_warmup   INTEGER NOT NULL DEFAULT 0,
  ts          TEXT NOT NULL,                  -- when the set was logged (absolute)
  updated_at  TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_sets_workout     ON sets(workout_id, exercise_id, set_no);
CREATE INDEX IF NOT EXISTS ix_sets_exercise_ts ON sets(exercise_id, ts);
CREATE INDEX IF NOT EXISTS ix_sets_seq         ON sets(seq);

-- ---------------------------------------------------------------- PROJECTS / STUDY
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project','study')),
  color       TEXT,                           -- hex, used in the day chart legend
  position    INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_projects_seq ON projects(seq);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  started_at TEXT NOT NULL,                   -- absolute; the timer UI derives elapsed = now - started_at
  ended_at   TEXT,                            -- NULL = running (visible on every device after sync)
  local_day  TEXT NOT NULL,                   -- day of started_at
  duration_s INTEGER,                         -- set on end (ended - started) or typed for manual entries
  note       TEXT,                            -- 'what got done'
  source     TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','cli','shortcut')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_day     ON sessions(local_day);
CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project_id, started_at);
CREATE INDEX IF NOT EXISTS ix_sessions_seq     ON sessions(seq);

-- Beginning / end of day check-in, one row per day.
CREATE TABLE IF NOT EXISTS checkins (
  local_day      TEXT PRIMARY KEY,
  morning_at     TEXT,
  morning_plan   TEXT,                        -- up to 3 lines: today's intentions
  morning_energy INTEGER CHECK (morning_energy BETWEEN 1 AND 5),
  evening_at     TEXT,
  evening_rating INTEGER CHECK (evening_rating BETWEEN 1 AND 5),
  evening_note   TEXT,
  updated_at     TEXT NOT NULL,
  seq            INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT
);
CREATE INDEX IF NOT EXISTS ix_checkins_seq ON checkins(seq);

-- ---------------------------------------------------------------- MORNING ROUTINE (NFC)
CREATE TABLE IF NOT EXISTS routine_items (
  id             TEXT PRIMARY KEY,            -- slug the Shortcut sends: shower|run|stretch|shoulders|journal
  name           TEXT NOT NULL,
  icon           TEXT,                        -- name of an inline SVG icon in the PWA
  position       INTEGER NOT NULL DEFAULT 0,
  default_min    INTEGER NOT NULL DEFAULT 10, -- block drawn on the day chart, ending at done_at
  chart_category TEXT NOT NULL DEFAULT 'routine' CHECK (chart_category IN ('routine','workout')),
  active         INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL,
  seq            INTEGER NOT NULL DEFAULT 0,
  deleted_at     TEXT
);
INSERT OR IGNORE INTO routine_items(id, name, icon, position, default_min, chart_category, active, updated_at) VALUES
  ('shower',    'Shower',           'shower',    1, 15, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('run',       'Morning run',      'run',       2, 30, 'workout', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('stretch',   'Morning stretch',  'stretch',   3, 10, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('shoulders', 'Shoulder routine', 'shoulders', 4, 10, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('journal',   'Morning journal',  'journal',   5, 10, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE INDEX IF NOT EXISTS ix_routine_items_seq ON routine_items(seq);

-- The primary key makes NFC double-taps idempotent: one row per item per local day.
CREATE TABLE IF NOT EXISTS routine_log (
  local_day  TEXT NOT NULL,
  item_id    TEXT NOT NULL REFERENCES routine_items(id),
  done_at    TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('nfc','app','cli')),
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,                            -- set when undone in the app; a later tap re-activates the row
  PRIMARY KEY (local_day, item_id)
);
CREATE INDEX IF NOT EXISTS ix_routine_log_seq ON routine_log(seq);

-- ---------------------------------------------------------------- SLEEP / BEDTIME
CREATE TABLE IF NOT EXISTS sleep (
  night_of    TEXT PRIMARY KEY,               -- local date of (bed_ts - 12h): 23:30 and 01:00 belong to the same night
  bed_ts      TEXT NOT NULL,
  wake_ts     TEXT,                           -- NULL until a wake tap / alarm / routine / manual fix
  bed_source  TEXT NOT NULL CHECK (bed_source IN ('nfc','app','cli')),
  wake_source TEXT CHECK (wake_source IN ('nfc','app','cli','alarm','routine')),
  target_bed  TEXT NOT NULL,                  -- 'HH:MM' snapshot of settings.bed_target that night
  late_min    INTEGER NOT NULL DEFAULT 0,     -- minutes after target (negative = early); streak = late_min <= late_grace_min
  updated_at  TEXT NOT NULL,
  seq         INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_sleep_seq ON sleep(seq);

-- ---------------------------------------------------------------- MANUAL TIME BLOCKS (gap filling)
CREATE TABLE IF NOT EXISTS time_blocks (
  id         TEXT PRIMARY KEY,
  start_ts   TEXT NOT NULL,
  end_ts     TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('sleep','workout','study','routine','meal','chores','social','commute','rest','phone','other')),
  label      TEXT,
  project_id TEXT REFERENCES projects(id),    -- when category = 'study'
  source     TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','cli')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT,
  CHECK (end_ts > start_ts)
);
CREATE INDEX IF NOT EXISTS ix_time_blocks_start ON time_blocks(start_ts);
CREATE INDEX IF NOT EXISTS ix_time_blocks_seq   ON time_blocks(seq);

-- ---------------------------------------------------------------- SCREEN TIME (server-only; written by the Mac script and the CLI)
-- Per-app seconds per UTC hour. Mac rows come from knowledgeC.db; phone rows from the screenshot fallback (app_id '_total').
CREATE TABLE IF NOT EXISTS screen_hours (
  source     TEXT NOT NULL CHECK (source IN ('mac','phone')),
  device     TEXT NOT NULL,                   -- hostname or 'iPhone'
  hour_start TEXT NOT NULL,                   -- UTC ISO at minute 0, e.g. '2026-09-28T13:00:00.000Z'
  app_id     TEXT NOT NULL,                   -- bundle id, or '_total' for phone hours
  seconds    INTEGER NOT NULL CHECK (seconds BETWEEN 0 AND 3600),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, device, hour_start, app_id)
);
CREATE INDEX IF NOT EXISTS ix_screen_hours_hour ON screen_hours(hour_start);

-- Merged 'app in focus' intervals (gaps < 2 min merged) so the day chart can place Mac time precisely.
CREATE TABLE IF NOT EXISTS screen_intervals (
  source     TEXT NOT NULL CHECK (source IN ('mac','phone')),
  device     TEXT NOT NULL,
  start_ts   TEXT NOT NULL,
  end_ts     TEXT NOT NULL,
  top_app    TEXT,                            -- bundle id with the most seconds inside the interval
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, device, start_ts),
  CHECK (end_ts > start_ts)
);
CREATE INDEX IF NOT EXISTS ix_screen_intervals_end ON screen_intervals(end_ts);

-- Per-app daily totals read off the iPhone Screen Time screenshot ('Most Used'); display only, never placed on the timeline.
CREATE TABLE IF NOT EXISTS phone_app_days (
  local_day  TEXT NOT NULL,
  app_label  TEXT NOT NULL,
  seconds    INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (local_day, app_label)
);

-- User-assigned category per Mac app (synced so the PWA can edit it). Unknown apps default to 'other'.
CREATE TABLE IF NOT EXISTS app_categories (
  app_id     TEXT PRIMARY KEY,                -- bundle id
  label      TEXT,                            -- friendly name resolved by the Mac script (mdfind) or typed
  category   TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('dev','work','comms','browsing','media','social','other')),
  updated_at TEXT NOT NULL,
  seq        INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_app_categories_seq ON app_categories(seq);

-- ---------------------------------------------------------------- ROLLUPS (server-only cache written by cron / POST /api/rollup)
CREATE TABLE IF NOT EXISTS day_summary (
  local_day          TEXT PRIMARY KEY,
  sleep_s            INTEGER NOT NULL DEFAULT 0,
  workout_s          INTEGER NOT NULL DEFAULT 0,
  study_s            INTEGER NOT NULL DEFAULT 0,
  routine_s          INTEGER NOT NULL DEFAULT 0,
  mac_s              INTEGER NOT NULL DEFAULT 0,
  phone_s            INTEGER NOT NULL DEFAULT 0,
  manual_s           INTEGER NOT NULL DEFAULT 0, -- meal/chores/social/commute/rest/other blocks
  unknown_s          INTEGER NOT NULL DEFAULT 0,
  tracked_s          INTEGER NOT NULL DEFAULT 0, -- 86400 minus future minutes (today); equals the sum of all *_s columns
  mac_by_category    TEXT NOT NULL DEFAULT '{}', -- JSON {"dev":s,"browsing":s,...}
  study_by_project   TEXT NOT NULL DEFAULT '{}', -- JSON {project_id: s}
  manual_by_category TEXT NOT NULL DEFAULT '{}', -- JSON {"chores":s,...}
  kcal               REAL,
  protein_g          REAL,
  carb_g             REAL,
  fat_g              REAL,
  sets_count         INTEGER NOT NULL DEFAULT 0,
  volume             REAL NOT NULL DEFAULT 0,    -- sum(reps*weight) in settings.weight_unit
  sessions_count     INTEGER NOT NULL DEFAULT 0,
  routine_done       INTEGER NOT NULL DEFAULT 0,
  routine_total      INTEGER NOT NULL DEFAULT 0,
  bed_late_min       INTEGER,                    -- from sleep where night_of = local_day
  final              INTEGER NOT NULL DEFAULT 0, -- 1 once the day is >= 2 days old and rolled up; served from cache after that
  computed_at        TEXT NOT NULL
);

-- ---------------------------------------------------------------- OPS
-- Every POST /api/tap, including duplicates, for the Settings > NFC log screen. Cron keeps the last 500 rows.
CREATE TABLE IF NOT EXISTS tap_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  item   TEXT NOT NULL,
  role   TEXT NOT NULL,
  result TEXT NOT NULL                          -- routine_done | routine_already_done | bed | bed_duplicate | wake | wake_duplicate | winddown | unknown_item
);

-- Cache for Open Food Facts / USDA lookups (30 days) so a barcode is fetched once.
CREATE TABLE IF NOT EXISTS lookup_cache (
  key        TEXT PRIMARY KEY,                  -- 'bc:<barcode>' | 'q:<type>:<query>'
  json       TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
```

## API
- GET /api/health [none] — Liveness check used when setting up the Shortcut URL and by the PWA's online probe. | none -> 200 {ok:true, version}
- GET /api/me [app] — Validate the pasted APP_TOKEN on the Settings screen and fetch server time, tz and the current sync seq. | none -> {role:'app', tz, server_time, seq}
- POST /api/tap [shortcut or app] — Single ingest endpoint for every NFC sticker and Shortcuts automation. Server-timestamped and idempotent: routine items INSERT OR IGNORE into routine_log(local_day,item_id); 'bed'/'wake' run the sleep state machine (duplicate within 10 min ignored, >= 3 h after bed = wake); 'winddown' only logs to tap_log and returns the streak message. Every call is appended to tap_log. | {item: 'shower'|'run'|'stretch'|'shoulders'|'journal'|<any active routine_items.id>|'bed'|'wake'|'winddown', ts?: ISO (app/cli backfill only)} -> 200 {ok:true, action:'routine_done'|'routine_already_done'|'bed'|'bed_duplicate'|'wake'|'wake_duplicate'|'winddown', local_day, message:'Shower done - 3/5 - 07:42'}; 422 unknown_item
- POST /api/sync [app] — Push the PWA outbox: batched upserts into the synced tables with last-writer-wins on updated_at, all rows in one D1 batch stamped with the next seq. | {client_id, mutations:[{table, rows:[{...full row incl. updated_at, deleted_at}]}]} (max 200 rows, 256 KB) -> {applied:[{table,id}], rejected:[{table,id,reason}], seq}
- GET /api/sync [app] — Pull every synced-table row changed since the client's cursor (foods, meals, meal_items, food_log, exercises, workouts, sets, projects, sessions, checkins, routine_items, routine_log, sleep, time_blocks, settings, app_categories). | ?since=<seq>&limit=<=1000> -> {rows:{table:[...]}, next_since, more:boolean}
- GET /api/day/:date [app] — Compute the 24-hour timeline for one local day live from all sources (precedence in day_chart), plus totals, meal markers, tappable Unknown gaps and freshness of the Mac/phone feeds. | :date = YYYY-MM-DD -> {date, tz, now, blocks:[{start,end,category,sub,label,source,detail}], gaps:[{start,end}], markers:[{ts,kind:'meal',label,kcal}], totals:{sleep_s,workout_s,study_s,routine_s,mac_s,phone_s,manual_s,unknown_s,tracked_s,mac_by_category,study_by_project}, sources:{mac_last_post_at, phone_last_post_at}}
- GET /api/summary [app] — Week/month data: day_summary rows for a range; final days come from cache, at most 3 non-final days are recomputed live per request (10 ms CPU budget), the rest are returned with stale:true so the client can call /api/rollup for them. | ?from=YYYY-MM-DD&to=YYYY-MM-DD (<= 62 days) -> {days:[day_summary row + stale?]}
- POST /api/rollup [app] — Recompute and upsert day_summary for one day (same function as cron); used by the client for stale days and by the CLI after a backfill. | {day} -> {day, totals, final}
- GET /api/lookup/barcode/:code [app] — Proxy barcode lookup so the Worker can send a proper User-Agent and cache: Open Food Facts v3 product (gate on nutriments['energy-kcal_100g'] presence, never on status), fallback USDA Branded search by GTIN (strip leading zeros), normalized to the Food shape per 100 g; cached 30 days in lookup_cache; OFF 503 retried once after 2 s. | :code = EAN/UPC (check digit validated) -> {found:true, candidate:{name,brand,source,source_id,kcal_100,protein_100,carb_100,fat_100,fiber_100,sugar_100,serving_g,serving_text}} | {found:false}
- GET /api/lookup/search [app] — Free-text food search against USDA FoodData Central (never OFF search); nutrient ids 1008/1003/1005/1004/1079, sugars 2000 then 1063, de-duplicated by first occurrence; USDA key is a Worker secret (USDA_KEY) so it is never in client code. | ?q=<text>&type=generic|branded (generic -> dataType=Foundation,SR Legacy; branded -> Branded)&page=1 -> {candidates:[Food candidate + fdcId, householdServingFullText]}; 429 from USDA is passed through with retry_after
- POST /api/foods [app (used by the planner CLI from Claude Code)] — Create or update a food from a nutrition label read by Claude Code; server converts per-serving to per-100 g if only per-serving values are given and returns an Atwater 4/4/9 warning when |4P+4C+9F - kcal| > 15% of kcal. | {id?, name, brand?, serving_g, per_serving?:{kcal,protein_g,carb_g,fat_g,fiber_g?,sugar_g?}, per100?:{...}, serving_text?, source:'label'|'off'|'usda', source_id?} -> 201 {id, per100, warnings:[]}
- GET /api/foods [app (CLI)] — Resolve a food or meal by name for the CLI ('planner eat chicken rice'). | ?q=<text>&kind=food|meal -> {matches:[{id,name,brand,kcal_100|kcal,serving_g}]}
- POST /api/food-log [app (CLI)] — Log something eaten from Claude Code ('I had 180 g of the yogurt at 1pm'); server snapshots macros from the food/meal row and infers slot from local time. | {food_id|food_name|meal_id|meal_name, grams|scale, at?: ISO or 'HH:MM' local, slot?, note?} -> 201 {id, kcal, protein_g, carb_g, fat_g, local_day}
- POST /api/sessions [app (CLI)] — Add a finished work/study session from Claude Code ('log 90 min on planner: built the sync layer'). | {project: name|id, minutes | start+end (ISO or local 'HH:MM'), note, day?} -> 201 {id}
- POST /api/time-blocks [app (CLI)] — Fill Unknown gaps from Claude Code in bulk ('13:00-14:00 was groceries'). | {blocks:[{start,end,category,label?,project?}], day?} -> 201 {ids:[]}
- POST /api/screentime [mac (source must be 'mac') or app (source 'phone', from the CLI)] — Upsert per-app hourly seconds and merged focus intervals for one device; within the declared window existing rows for that (source, device) are deleted and replaced in one D1 batch, so hourly re-sends are idempotent; new bundle ids are inserted into app_categories with category 'other'. | {source:'mac'|'phone', device, window:{from,to}, hours:[{hour_start, app_id, seconds}], intervals?:[{start,end,top_app}], apps?:[{app_id,label}], phone_app_days?:[{local_day,app_label,seconds}]} (max 1 MB) -> {hours:n, intervals:n, apps_new:n}
- GET /api/tap/log [app] — Last 100 tap_log rows for the Settings > NFC debug screen (did the sticker fire?). | none -> {taps:[{ts,item,role,result}]}
- GET /api/export [app] — Full JSON dump of every table for the weekly backup (paired with wrangler d1 export). | none -> {exported_at, tables:{...}} (streamed)
- CRON scheduled('0 9 * * *') (09:00 UTC = 05:00 EDT / 04:00 EST) [n/a] — Daily maintenance under the 10 ms CPU cap: rollup yesterday and the day before (Mac data for late evening arrives after midnight), mark day_summary.final=1 for days >= 2 days old, auto-handle open sleep rows older than 14 h (wake_ts = first routine tap of the next local day if >= 3 h after bed, wake_source 'routine'; else leave NULL so Today asks), prune tap_log to 500 rows and lookup_cache to 30 days. | wrangler.jsonc triggers.crons = ['0 9 * * *']; any additional days needing rollup are handled lazily by GET /api/summary + POST /api/rollup

## SCREENS
### Today (home tab) — The glance screen: what is done, what is running, how last night went, and the day so far, all above the fold on an iPhone XS (375x812).
  - Top: date + sync dot (green synced / amber outbox pending / red token missing) + gear to Settings.
  - Day ring (24 segments, filled up to now with category colours; Unknown hatched) with 'tracked 9h 40m, unknown 1h 10m'; tap opens the Day tab on today.
  - Routine row: 5 large circles (56 px) in routine_items order with icon; done = filled with time underneath ('7:42'); tap = mark done now (routine_log via outbox, source 'app'); long-press = Undo / Set time.
  - Sleep card: 'In bed 23:20 (+20 min) - up 7:05 - 7h 45m - streak 4'; after 20:00 a big 'In bed' button; if a sleep row is open >= 3 h an 'I'm up' button; if wake unknown a 'When did you wake?' chip with a time wheel.
  - Running strip (only when something is running): 'Push - 24 min' and/or 'planner - 52:10' with End buttons; the strip persists on every tab.
  - Quick actions row: Start workout / Start session / Log meal (each one tap into the flow with defaults).
  - Check-in card: 05:00-11:00 shows 'Plan the day' if morning_at is null; after 20:00 shows 'Wrap up' if evening_at is null; hidden otherwise.
  - Pull-to-refresh = pull sync; the page also refreshes on visibilitychange.
### Food — Two-tap meal logging and the daily calories/macros vs targets, with the log below the fold.
  - Header (110 px): kcal bar '1,640 / 2,400' with remaining in bold, then three thin bars P/C/F with 'g / target'; tap header to switch to yesterday/tomorrow (swipe too).
  - Quick add grid (3x2 tiles, 230 px): top 6 presaved meals ranked by use_count x recency; tile shows name + kcal. Tap 1 opens a bottom sheet with portion chips 0.5x / 1x (default) / 1.5x / 2x / grams, slot auto-inferred (before 10:30 breakfast, 15:00 lunch, 20:30 dinner, else snack) with chips to override; tap 2 'Log 620 kcal' saves and dismisses; toast 'Logged - Undo'.
  - Long-press a tile = edit meal (goes to Meal builder).
  - Search row (56 px): text field searches local foods and meals first (instant, offline), 'Scan' button opens Add Food > Scan, 'More results (USDA)' link calls /api/lookup/search.
  - Log list grouped by slot with subtotal per slot; each row 'Greek yogurt 180 g - 190 kcal - 18P'; swipe left = delete (soft), tap = edit grams/scale; multi-select > 'Save as meal' turns today's picks into a presaved meal.
  - Empty state for the grid: 'Save your first meal' pointing to Meal builder.
### Add Food (Scan / Search / Label) — Get a new food into the library in the fewest confident steps, then log it in grams.
  - Segmented control Scan | Search | Label; Scan is default when opened from the Scan button.
  - Scan: a single big 'Take photo of barcode' button backed by <input type=file accept=image/* capture=environment> (no getUserMedia in the installed app); the still is decoded with the barcode-detector ponyfill (formats ean_13, upc_a, ean_8, upc_e) and check-digit validated; on failure 'Try again' plus a manual barcode field. A 'Live scan (experimental)' toggle in Settings enables a getUserMedia loop for when Apple fixes the rotation bug.
  - After a code: GET /api/lookup/barcode/:code -> candidate card showing name, brand, per-100 numbers (each editable), serving; buttons 'Log now' (opens the grams pad pre-filled with serving_g) and 'Save only'; if not found the Label form opens with source_id pre-filled.
  - Search: USDA generic by default (chicken breast, rice), 'Branded' toggle; results list shows kcal/100 g and serving text; tap = candidate card as above.
  - Label: name, brand, serving size in grams (required; if the label gives cups/ml the field hint says 'weigh one serving once'), per-serving kcal/P/C/F/fiber/sugar; live per-100 g preview and a 4/4/9 chip (green within 15%, amber otherwise; never blocks); 'Save' or 'Save and log X g'.
  - Grams pad: large numeric keypad with quick chips for 1 serving, 50, 100, 150, 200 g; shows kcal as you type; 'Log' commits (food_log via outbox) and increments use_count.
### Meal builder — Create and edit presaved meals so recurring meals are logged without re-checking items.
  - Name, optional default slot, list of items (food + grams) with running totals for 1x.
  - Add item: same local search as Food; grams pad; reorder by drag; swipe to remove.
  - Totals recomputed client-side and stored on the meal row (kcal, protein_g, ...), then synced.
  - 'Duplicate meal' for variants (e.g. same bowl with 200 g rice).
  - Delete = soft delete; historical food_log rows keep their snapshots.
### Lift (start + history) — Start the right session in one tap and browse past sessions easily.
  - Top: chips of the last 5 distinct workout names by recency ('Push', 'Pull', 'Legs', '+ Empty'); tap 'Push' creates a workout (name Push, started_at now) pre-populated with the exercise list of the last 'Push' session in order and jumps to Active Workout on exercise 1.
  - History list below, grouped by month: 'Push - Tue 24 Sep - 52 min - 18 sets - 7,420 kg'; tap = read-only session detail (exercises, sets, PR badges) with 'Repeat this' button.
  - Exercise library link: list sorted by use_count; tap = Exercise progress.
  - Search field filters history by workout name or exercise.
  - Everything reads from IndexedDB, so history works offline in the gym.
### Active Workout — Log a set with one thumb tap, sweaty hands, no scrolling: current exercise, last session's numbers, big Log button.
  - Header: workout name + elapsed (from started_at) + 'Finish'. Below: exercise pager (horizontal swipe between exercises, dots indicator, 'Add exercise' as the last page).
  - Exercise page top: name, ghost line 'Last (24 Sep): 60x8, 60x8, 60x7' and PR line 'Best e1RM 78'.
  - Set row (72 px tall controls): weight stepper [-] 60 [+] (step = exercises.weight_step; tap the number for a numeric pad), reps stepper [-] 8 [+], and a full-width 64 px 'LOG SET 3' button. Pre-fill rule: set N pre-fills from last session's set N of this exercise; if none, from set N-1 of this session; if none, from the exercise's last logged set ever. One tap logs (sets row via outbox, ts = now) and the row re-arms for set N+1.
  - Logged sets list under the controls: '1  60 x 8   14:02', '2  60 x 8   14:05' with PR badge if e1RM beats history; tap = edit sheet (reps/weight/warm-up), swipe = delete.
  - 'Warm-up' toggle on the row marks is_warmup (excluded from best-set/volume).
  - 'Next exercise' button at the bottom of the page (also reachable by swipe); adding an exercise opens a search with recent-first list and 'Create <name>'.
  - Finish: sets ended_at, shows summary toast '52 min - 18 sets - 7,420 kg - 2 PRs' and returns to Lift; a workout left open > 3 h is auto-closed on next launch with ended_at = last set ts + 2 min.
  - Optional 'Keep screen on' toggle in the header (Screen Wake Lock, released on hide).
### Exercise progress — See progress per exercise over time: best set (Epley e1RM) and volume per session.
  - Two inline-SVG charts: e1RM line with PR dots, volume bars; range chips 1M / 3M / 1Y / All.
  - Tap a point = that session's sets for this exercise in a card below.
  - Table of last 10 sessions: date, top set, total reps, volume.
  - Edit exercise: name, muscle, load type, weight step; merge duplicates.
### Work (projects + sessions) — Start a study/project timer in one tap, end it with one line about what got done, and see hours per project.
  - Running session banner at top (elapsed from started_at, recomputed on visibilitychange; optional Wake Lock toggle) with 'End' -> End sheet: single auto-focused text field 'What got done?', editable duration, project chip, 'Save'. The sheet also has 'Discard'.
  - Project rows (56 px) with a big 'Start' button each; starting while another runs asks 'End <other> first?' with its note field inline.
  - '+ Manual' opens: project, duration (chips 25/50/90 min or a picker), optional start time, note.
  - Today's sessions list with notes; weekly mini bars per project (hours this week vs last week).
  - Project management: add/rename/colour/archive; kind = project or study.
  - Sessions created from the Mac (same PWA in Safari) or CLI appear on the phone after the next pull.
### Check-ins (morning / evening sheets) — Beginning- and end-of-day reflection in under a minute, tied to what was actually logged.
  - Morning sheet (from the Today card): 3 short text lines 'Today I will...' and energy chips 1-5; Save writes checkins.morning_*.
  - Evening sheet: shows today's sessions with their notes, sets count, meals kcal, routine 5/5, then rating chips 1-5 and one note field 'What got done / what to change'; Save writes checkins.evening_*.
  - Both sheets can be reopened from Today (tap the card) to edit; history is visible in the Day tab detail pane.
### Day chart (Day / Week / Month) — The spending-tracker for time: where the 24 hours went, with tappable Unknown gaps, and weekly/monthly category comparisons.
  - Segmented control Day | Week | Month; swipe left/right changes the day/week/month; 'Today' button.
  - Day view: category summary strip at top (horizontal stacked bar: sleep, workout, study, routine, mac, phone, other, unknown with h m labels), then a vertical 24 h timeline (00:00 top, 1 px = 1 min, 1440 px scrollable, auto-scrolled to now on today) with coloured blocks and labels ('Study: planner - VS Code 48m'), meal markers as small icons at their time, Mac blocks tinted by app category.
  - Tap a block = detail sheet (source, exact times, top apps inside, edit/delete for manual blocks, 'Split' to fix wrong ranges).
  - Unknown gaps (>= 5 min) are hatched with a '+' badge; tap = Fill sheet: category chips (sleep, workout, study + project picker, routine, meal, chores, social, commute, rest, phone, other), optional label, and two quick buttons 'Same as previous block' / 'Same as next block'; Save creates a time_block via outbox. Long-press a gap = drag handles to adjust the range first.
  - Week view: 7 stacked columns (Mon-Sun) by category plus a totals list 'Sleep 52h 10m (avg 7h 27m) +1h 05m vs last week', 'Study 18h 40m -2h', 'Unknown 9h 15m'; the current week shows 'so far' and compares Mon-today against the same days of last week. Bedtime row: 7 dots vs the target line, late minutes labelled.
  - Month view: category totals with % of tracked time and delta vs previous month, a per-day strip showing unknown share (so days lacking data are obvious), and per-project study hours.
  - Data freshness line: 'Mac data up to 14:05, phone: none today - paste a Screen Time screenshot into Claude Code'.
### Settings — One-time setup and the few knobs that exist.
  - APP_TOKEN paste field with 'Test' (GET /api/me) and a status line; stored in localStorage and Dexie kv, never in the bundle.
  - Timezone (default from the browser), weight unit, calorie/macro targets, bed target, wind-down minutes, late grace minutes, wake target.
  - Routine items editor (name, icon, order, default minutes, chart category, active) and a 'Shortcut setup' page that shows the exact URL, the item slugs and step-by-step instructions.
  - Projects and exercises management links; Mac app categories table (bundle id, label, category picker) fed by the Mac script.
  - NFC log (last 100 taps with result) for debugging stickers; 'Force sync'; 'Export JSON'; 'Reset local cache' (re-pulls from server).
  - Install hints: iPhone Share > Add to Home Screen; Mac Safari File > Add to Dock.

## OFFLINE/SYNC
STORAGE. Dexie database 'planner' with one object store per synced table (same columns as D1, primary key = the D1 primary key, natural keys for routine_log [local_day+item_id], checkins, sleep, settings, app_categories), plus 'outbox' (auto id, table, row, queued_at, attempts), 'kv' (app_token, cursor_seq, client_id, last_pull_at) and 'cache' (server-computed /api/day and /api/summary responses keyed by date, with fetched_at). navigator.storage.persist() is called once on first launch (auto-granted for home-screen apps, no prompt). The token is also mirrored in localStorage inside try/catch; if both are missing the app shows the token banner and keeps queuing writes.

WRITES. Every mutation goes through a repository function (logSet, logFood, tapRoutine, startSession, ...) that (1) sets updated_at = new Date().toISOString() and fills local_day via the shared tz helper, (2) puts the row into its Dexie store, (3) appends it to the outbox, (4) kicks the flusher. UI reads come from Dexie liveQuery wrapped in signals, so the set appears instantly even in a basement gym. Deletes are soft (deleted_at) and sync like updates.

FLUSH (push). A single in-flight promise; takes up to 200 outbox rows, groups by table, POST /api/sync. On 2xx: remove applied rows, store seq as cursor, run a pull. On 401: stop, show the token banner. On 422 per-row rejection: drop the row and surface a toast. On network error: retry with backoff 2 s, 10 s, 60 s, then wait for 'online', visibilitychange -> visible, or the next write. The Worker applies each row as INSERT ... ON CONFLICT(pk) DO UPDATE SET ... WHERE excluded.updated_at > <table>.updated_at inside one env.DB.batch(), after bumping sync_meta.seq once per request and stamping every row with it; last-writer-wins by client wall clock is acceptable for one user on two devices.

PULL. GET /api/sync?since=<cursor>&limit=1000, loop while more; rows are applied with the same rule (skip if the local row has a newer updated_at and is still in the outbox). Triggered at launch, on visibilitychange -> visible, after every successful flush, and every 60 s while visible; first launch pulls from 0 (a few thousand rows at most). Shortcut, Mac-script and CLI writes are server-first, so the phone sees them within 60 s while open or immediately at launch. Request budget is roughly 2k/day against the 100k/day free limit.

SERVER-COMPUTED DATA. /api/day and /api/summary responses are cached in Dexie 'cache' and rendered stale-while-revalidate (today's TTL 60 s, past days until a local write touches that day or a 'stale' flag comes back). If offline, the last cached chart is shown with an 'offline' badge.

TIMERS. sessions.started_at and workouts.started_at are absolute timestamps stored locally and synced; elapsed is computed from Date.now() on requestAnimationFrame while visible and recomputed on visibilitychange/focus/pageshow (JS is frozen in the background on iOS). A running session is just a row with ended_at NULL, so the Mac shows and can end it. Screen Wake Lock is an explicit toggle on the timer and active-workout screens (works in installed web apps on iOS 18.4+), released on hide and re-requested on visible. No audible alerts are promised while locked.

SERVICE WORKER. vite-plugin-pwa generateSW: precache the built shell, navigateFallback '/index.html', runtimeCaching /api/* NetworkOnly (Dexie is the data cache), registerType 'autoUpdate' with a 'Reload for update' toast that calls skipWaiting. Manifest: name/short_name 'Planner', id and start_url '/', scope '/', display 'standalone', 192/512 maskable icons, theme_color; head: viewport-fit=cover, apple-mobile-web-app-capable, apple-touch-icon 180 px, solid status bar (black-translucent is deprecated), env(safe-area-inset-*) padding on the tab bar, 16 px input fonts.

BACKUPS. Weekly launchd job on the Mac runs `npx wrangler d1 export planner --remote --output ~/planner-backups/$(date +%F).sql`; GET /api/export provides a JSON dump; D1 Time Travel covers 7 days.

## NFC/SHORTCUTS
ONE SHARED SHORTCUT 'Planner Tap' (holds the URL and token once): action 1 'Get Contents of URL' -> URL https://planner.<subdomain>.workers.dev/api/tap, Method POST, Headers Authorization: Bearer <SHORTCUT_TOKEN>, Content-Type: application/json, Request Body JSON with one Text field item = Shortcut Input; action 2 (optional) 'Get Dictionary Value' message from Contents of URL; action 3 (optional) 'Show Notification' with that message ('Shower done - 3/5 - 07:42', 'In bed 23:20 (+20)', 'Already logged'). Run it once manually with input 'shower' and choose Always Allow when asked. The Worker timestamps server-side and ignores any ts from the shortcut role.

SIX AUTOMATIONS (Shortcuts > Automation > + > NFC > scan sticker > Run Immediately, Notify When Run off > Run Shortcut 'Planner Tap' with Input = the slug): shower, run, stretch, shoulders, journal at their stations, and bed on the nightstand. NTAG213 25 mm PET stickers; iOS matches the tag UID and ignores NDEF content, so also write https://planner.<subdomain>.workers.dev/t/<slug> to each tag with NFC Tools as a guest/Android fallback (the Worker serves /t/<slug> as a tiny confirm page for the app role only). Gesture: raise to wake, Face ID, touch the top edge to the sticker for about 1 s; nothing opens. Automations do not sync via iCloud: recreate on a new phone, and re-check 'Run Immediately' after each iOS update.

IDEMPOTENCY. Routine items: INSERT OR IGNORE INTO routine_log(local_day, item_id, done_at, source='nfc'); a second tap returns action 'routine_already_done' and the original time; local_day is computed in settings.tz. If the row was undone in the app (deleted_at set), a new tap clears deleted_at and updates done_at. Bed/wake: the sleep state machine in shared/sleep.ts (used by the Worker and by the in-app buttons) keys on night_of = local date of (now - 12 h): (a) no row -> insert bed_ts = now, target_bed = settings.bed_target, late_min = minutes between the target instant of that night (target time on night_of; if the target is before 12:00 it is the next calendar day) and now; (b) row with wake_ts NULL and now - bed_ts < 10 min -> 'bed_duplicate', ignored; (c) row with wake_ts NULL and 10 min <= now - bed_ts < 3 h -> ignored too (got up for water, tapped again; the first bed time stands, which is the honest number for 'getting to bed on time'); (d) row with wake_ts NULL and now - bed_ts >= 3 h -> wake_ts = now, wake_source 'nfc' (same sticker doubles as the wake sticker); (e) row already has wake_ts and local hour >= 18 -> the earlier interval was a nap: it is converted into a time_block(category 'sleep', label 'nap') and the row is reset to bed_ts = now, wake_ts NULL; (f) row has wake_ts and it is daytime -> 'wake_duplicate'. item 'wake' forces path (d) or 'wake_duplicate' and is used by an optional Shortcuts Alarm automation ('When my alarm is stopped' -> Run Planner Tap with 'wake'; test on iOS 27, it is a standard personal-automation trigger). Fallback wake: the first routine tap of the following local day at least 3 h after bed closes the row with wake_source 'routine' (done in /api/tap and again in cron); otherwise Today shows a 'When did you wake?' chip and the chart draws 'sleep?' to bed + 8 h.

IN-APP FALLBACK. Today's routine circles write routine_log rows through the outbox (source 'app'); the 'In bed' and 'I'm up' buttons run the same sleep state machine locally and upsert the sleep row through the outbox (offline-safe); server and client converge because both write the same natural key with last-writer-wins.

BEDTIME. settings.bed_target (default 23:00) and winddown_min (45). Shortcuts Time of Day automation at bed_target minus winddown_min, daily, Run Immediately: action 1 'Show Notification' 'Wind down - bed by 23:00' (always fires, local, never revoked, unlike Web Push); action 2 Run 'Planner Tap' with input 'winddown', whose response message carries the streak ('Streak 4 nights - last night 23:20 (+20)') for an optional second notification. Streak = consecutive nights ending last night with late_min <= late_grace_min (15); Today and the wind-down message show it, Week view plots bedtime dots against the target line, Month view shows average late minutes and nights on target. Changing bed_target in Settings updates the app; the Time-of-Day automation itself must be edited by hand (the Settings page reminds you).

## MAC SCRIPT
FILE ~/bin/screentime_push.py (chmod 700), run by /usr/bin/python3 (Apple's 3.9.6; only stdlib: sqlite3, shutil, tempfile, json, urllib.request, subprocess, datetime, pathlib, socket).

WHAT IT READS. Only knowledgeC.db (~/Library/Application Support/Knowledge/knowledgeC.db) -- the ScreenTimeAgent store (RMAdminStore) is EPERM even with Full Disk Access on macOS 26.3+ and is not touched. Safe read: copy knowledgeC.db plus -wal and -shm to tempfile.mkdtemp(), open the copy with sqlite3.connect('file:...?mode=ro', uri=True), never immutable=1 on the live file, rmtree at the end. Window = [max(last_watermark - 3 h, now - 26 h), now). Query: SELECT ZOBJECT.ZVALUESTRING AS bundle, ZOBJECT.ZSTARTDATE + 978307200 AS start_unix, ZOBJECT.ZENDDATE + 978307200 AS end_unix FROM ZOBJECT LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK WHERE ZOBJECT.ZSTREAMNAME = '/app/inFocus' AND ZSOURCE.ZDEVICEID IS NULL AND ZOBJECT.ZENDDATE > ? ORDER BY start_unix; if it returns zero rows for the window, rerun with '/app/usage' (both streams exist; inFocus is strictly frontmost and therefore non-overlapping). Device rows with a non-NULL ZDEVICEID are skipped (legacy synced-device rows, unverified on macOS 26). If a '/display/isBacklit' stream is present in the copy, intervals are intersected with its value = 1 ranges to drop screen-off time; if absent this step is skipped.

BUCKETING. Each interval is clipped to the window and split at UTC hour boundaries; seconds are summed per (bundle, hour_start) -> hours[] (cap 3600 per app-hour). Intervals from all apps are sorted and unioned with a 120 s gap tolerance; unions shorter than 60 s are dropped; each union records top_app = bundle with the most seconds inside -> intervals[]. New bundle ids (not in ~/.config/planner/app_names.json) are resolved once with `mdfind "kMDItemCFBundleIdentifier == '<id>'"` -> app bundle name and cached -> apps[]. The per-hour sum across apps is clamped to 3600 by the Worker when charting, not here.

WHAT IT POSTS. One request: POST https://planner.<subdomain>.workers.dev/api/screentime with Authorization: Bearer <MAC_TOKEN>, body {"source":"mac","device":socket.gethostname(),"window":{"from":..,"to":..},"hours":[{"hour_start","app_id","seconds"}],"intervals":[{"start","end","top_app"}],"apps":[{"app_id","label"}]}, urllib.request.urlopen(req, timeout=30). The Worker deletes existing mac rows for that device inside the window and inserts the new ones in one batch, so the 3-hour overlap re-send is idempotent and in-progress hours get corrected next run. On 2xx the watermark ~/.config/planner/last_run is written with the window end. Typical volume: ~35 rows per run, under 1,000 D1 row writes per day.

SCHEDULE. ~/Library/LaunchAgents/com.pranav.planner-screentime.plist (0644, no secrets): ProgramArguments [/usr/bin/python3, /Users/pranavgadiraju/bin/screentime_push.py], StartCalendarInterval Minute=5 (every hour at :05), RunAtLoad true, EnvironmentVariables PLANNER_URL, StandardOutPath/StandardErrorPath under ~/Library/Logs/. Load: launchctl bootstrap gui/$(id -u) <plist>; force: launchctl kickstart -k gui/$(id -u)/com.pranav.planner-screentime. Missed hours are covered by the 26 h window and the watermark.

SECURITY. MAC_TOKEN lives in the login Keychain: `security add-generic-password -a "$USER" -s planner-mac-token -w` once; the script reads it with subprocess ['security','find-generic-password','-s','planner-mac-token','-w'] (first run prompts 'Always Allow' for python3); fallback: chmod 600 ~/.config/planner/mac_token. The token is write-only on the server (mac role may only POST /api/screentime with source 'mac'), so a leaked token cannot read anything. Full Disk Access for /usr/bin/python3: System Settings > Privacy & Security > Full Disk Access, drag /usr/bin/python3 from a Finder window opened with Cmd+Shift+G (the '+' picker was broken for bare binaries in 26.1-26.2); verify with the one-liner that counts ZOBJECT rows, or via the TCC.db query for kTCCServiceSystemPolicyAllFiles; also grant Terminal for manual testing. The Worker rejects bodies over 1 MB, non-ISO timestamps, and windows over 48 h.

STRETCH (later milestone). iPhone usage from ~/Library/Biome/streams/restricted/App.InFocus/remote/<device_id>/ via aw-import-screentime once 'Share Across Devices' is on; the script would post those as source 'phone', device 'iPhone', and they take precedence over screenshot-derived '_total' hours for the same hour.

## DAY CHART
INPUT. local day D in settings.tz (D_start = D 00:00 local as UTC instant, D_end = D_start + 24 h), now, and rows overlapping [D_start, D_end): time_blocks, sleep (bed_ts < D_end AND coalesce(wake_ts, bed_ts + 14 h) > D_start), workouts, sessions, routine_log joined to routine_items, screen_intervals, screen_hours, food_log (markers only), app_categories, projects. All fetched with 8 indexed SELECTs in one env.DB.batch(); a normal day is a few hundred rows.

SLOTS. slots = array of 1440 minute cells, each {cat, sub, label, src}; initialised to UNKNOWN; if D is today, minutes after now are FUTURE and excluded from everything. A layer 'claims' a minute only if the cell is UNKNOWN, except layer 1 which always overwrites. Layers, applied in this order (earlier = higher precedence):
1. Manual time_blocks (source app/cli): category, label, project -> always win; the user explicitly said so.
2. Sleep: [bed_ts, wake_ts) -> 'sleep'. Open row (wake NULL): if bed_ts within the last 14 h draw to now, else draw to bed_ts + 8 h with label 'sleep?' (chart shows a dashed edge and Today asks for the wake time). Naps converted to time_blocks come in via layer 1.
3. Workouts: [started_at, coalesce(ended_at, min(now, started_at + 3 h))) -> 'workout', label = name; detail = sets count.
4. Sessions: [started_at, coalesce(ended_at, now)) -> 'study', sub = project_id, label = project name, detail = note plus the top Mac apps inside the range (from screen_hours overlap), e.g. 'Study: planner - VS Code 48m, Safari 12m'. A workout overlapping a forgotten running session wins because it is layer 3.
5. Routine taps: [done_at - default_min, done_at) -> routine_items.chart_category ('routine', or 'workout' for run), label = item name; clipped by anything already claimed.
6. Mac screen_intervals (source mac): each interval -> 'mac', sub = app_categories[top_app].category or 'other', label = app label. Intervals for two Macs are unioned.
7. Mac screen_hours without intervals (hours that only have per-app totals, e.g. older data): for each hour, m = min(round(sum(seconds)/60), 60) minutes are filled into the still-UNKNOWN cells of that hour from the hour start onward, sub = category with the most seconds.
8. Phone hours (source phone, app_id '_total', from the screenshot fallback or later Biome data): for each hour, fill min(round(seconds/60), 60) still-UNKNOWN cells of that hour -> 'phone'. Mac placement is precise so it goes first; phone minutes take what is left of the hour.
9. Everything else stays UNKNOWN.

POST-PROCESSING. Run-length encode the slots into blocks; merge adjacent blocks with equal (cat, sub, label). UNKNOWN runs shorter than 5 minutes are absorbed into the preceding block (display and totals) to remove noise; UNKNOWN runs >= 5 min become 'gaps' with start/end so the client can render the hatched '+' block. Meal markers: food_log rows for D -> {ts, label, kcal}, drawn as icons, never as time. Totals: seconds per top-level category over non-FUTURE cells (sleep_s, workout_s, study_s, routine_s, mac_s, phone_s, manual_s = meal/chores/social/commute/rest/other/phone-manual, unknown_s), tracked_s = sum of all, mac_by_category from cell sub, study_by_project from cell sub, manual_by_category. Also computed for day_summary: kcal/macros from food_log, sets_count and volume (non-warm-up) from sets on D, sessions_count, routine_done/total, bed_late_min from sleep.night_of = D. Cost: one pass over 1440 cells plus a few hundred rows, well under the 10 ms CPU cap.

FRESHNESS. GET /api/day/:date always computes live (today changes every minute). GET /api/summary uses day_summary rows where final = 1; for other days it recomputes at most 3 per request and flags the rest stale; cron rolls up D-1 and D-2 at 09:00 UTC and sets final = 1 when D <= today - 2 (late Mac posts for the previous evening have landed by then); any later manual gap fill on a final day triggers POST /api/rollup from the client so the cache is corrected.

ROLLUPS. Week = Monday to Sunday in settings.tz; the client sums day_summary columns and the JSON maps; comparison = same category in the previous week; for the current week it compares Monday..today against Monday..same weekday of last week ('so far'). Month = calendar month, same rule against the previous month, plus averages per day. Days with tracked_s = 0 (no data at all, e.g. before the app existed) are excluded from averages and drawn as 'no data'; days with data but large Unknown keep their Unknown share visible. Bedtime rollups: nights on target = count(late_min <= grace), average late minutes, current streak computed from the sleep table directly (cheap: one indexed scan of the last 60 nights).

## CLAUDE CODE HELPERS
THE `planner` CLI (bin/planner, Node 20+, plain ESM JS, no deps) is how Claude Code writes to the app without ever seeing the token: base URL from ~/.config/planner/config.json, token from the login Keychain (`security find-generic-password -s planner-app-token -w`; stored once with add-generic-password) or PLANNER_TOKEN env for CI. Commands: `planner food add --json '<Food>'` or `--stdin` (POST /api/foods; prints the per-100 g table and any 4/4/9 warning); `planner food search "<q>"` (GET /api/foods); `planner eat --food "<name|id>" --grams 180 [--at 13:00] [--slot lunch]` and `planner eat --meal "<name>" [--scale 0.5]` (POST /api/food-log); `planner session add --project "<name>" --minutes 90 --note "..." [--start 14:00] [--day 2026-09-27]` (POST /api/sessions); `planner block add --from 13:00 --to 14:00 --category chores --label "groceries" [--day ...]` and `planner block add --json '[...]'` (POST /api/time-blocks); `planner screentime phone --day 2026-09-27 --hours '[{"h":7,"min":12},...]' --apps '[{"app":"Safari","min":48},...]'` (POST /api/screentime with source 'phone', device 'iPhone', '_total' hour rows in UTC computed from the local day, plus phone_app_days); `planner tap <item>` (POST /api/tap, app role, for tests); `planner day [date]` (GET /api/day, prints the timeline as text so Claude can answer 'how did yesterday go'); `planner rollup <day>`; `planner export`. Every command prints the server response and exits non-zero on error.

CLAUDE.md IN THE REPO tells Claude Code how to use it, so the user only pastes an image: (1) 'Nutrition label photo pasted: read serving size in grams (if the label only gives a household measure, ask for the weighed grams), read per-serving kcal, protein, carbs, fat, fiber, sugars; compute per-100 g = per_serving x 100 / serving_g; check |4P + 4C + 9F - kcal| <= 15% of kcal and say so; show a table and ask for the food name/brand if not legible; on confirmation run `planner food add --json ...`; never invent digits, ask when unreadable.' (2) 'iPhone Screen Time Day-view screenshot pasted: extract the date, the daily total, the 24 hourly bars as minutes (state which hours you are unsure about), and the Most Used list; run `planner screentime phone ...`; treat grey/unattributed time as part of the hour total; do not distribute apps across hours.' (3) 'Text like "I ate 200 g of the chicken bowl at 1pm" -> `planner eat`; "log 2 h on planner, wrote the sync layer" -> `planner session add`; "1 to 2pm was groceries" -> `planner block add`.' (4) 'Never print the token; never edit ~/.config/planner or the Keychain.' A `/label` and a `/screentime` skill file under .claude/skills/ wrap prompts (1) and (2) so they are one slash command each. The Worker's /api/foods 4/4/9 check is the second line of defence, and the app's Food tab shows CLI-added foods with a 'from Claude' badge for a quick eyeball before first use.

## MILESTONES
- **M1 - Skeleton, routine stickers, bedtime, Today**: Repo planner/ with wrangler.jsonc (assets + D1 + cron), schema.sql applied, secrets APP_TOKEN/SHORTCUT_TOKEN/MAC_TOKEN set, Worker with auth (constant-time compare, roles), /api/health, /api/me, /api/tap (routine + sleep state machine in shared/sleep.ts), /api/sync push/pull, /api/tap/log; PWA shell (Preact, Dexie, outbox, service worker, manifest) with the Today and Settings screens (routine circles, sleep card, In bed / I'm up, check-in placeholders hidden); deployed to workers.dev and installed on the iPhone and Mac; six NTAG213 stickers, the shared 'Planner Tap' shortcut, six NFC automations and the wind-down Time-of-Day automation; a weekly wrangler d1 export launchd job.
  - verify: Tap the shower sticker with the phone locked-but-awake and again unlocked; `wrangler d1 execute planner --remote --command "select * from routine_log"` shows one row per item per day even after a double tap; Today shows the checked circle within a pull; go to bed via sticker, tap again in the morning: sleep row has bed_ts, wake_ts and the right late_min; airplane-mode tap of an in-app circle syncs when back online; tap log screen shows every tap with its result.
- **M2 - Food**: foods/meals/meal_items/food_log flows: Food tab with targets header, quick-add grid and two-tap logging, Label entry form with per-100 conversion and 4/4/9 chip, Meal builder and 'save today's picks as meal', slot inference; the `planner` CLI with food add / eat / food search and CLAUDE.md so a pasted label photo becomes a food; then barcode (still photo + barcode-detector ponyfill) and USDA search via /api/lookup/* with lookup_cache.
  - verify: Log a presaved meal from the Food tab in exactly two taps and confirm totals match a hand calculation; enter a label by hand and compare per-100 to the printed values; paste a label photo into Claude Code and see the food appear in the app after one pull; scan three real barcodes (one missing in OFF) and confirm the USDA fallback and the not-found path; totals for a day survive editing a food afterwards (snapshots).
- **M3 - Lift**: exercises/workouts/sets, Lift start chips pre-populated from the last same-name workout, Active Workout pager with steppers, pre-fill rule and one-tap Log, warm-up flag, PR detection, Finish summary, History list and session detail, Exercise progress charts (e1RM line, volume bars).
  - verify: Second 'Push' session opens with the same exercises and every set pre-filled from the previous session's set N; a full workout logged in the gym with no signal appears on the Mac after reconnecting with no duplicates; PR badge appears when e1RM exceeds history; charts render for an exercise with 10+ sessions.
- **M4 - Work sessions and check-ins**: projects/sessions/checkins: Work tab with one-tap Start per project, running banner on every tab, End sheet with auto-focused 'What got done?', manual add, weekly per-project bars; morning and evening check-in sheets on Today; CLI `session add`.
  - verify: Start a session on the phone, end it on the Mac with a note, see the duration and note on both; timer shows correct elapsed after the phone was locked for 20 minutes; morning and evening check-ins persist and show in history.
- **M5 - Day chart v1 and rollups**: /api/day, /api/summary, /api/rollup, cron rollup and day_summary; Day tab with summary strip, 24 h timeline, block detail sheet, Unknown gap fill (time_blocks), Week and Month views with previous-period comparison and bedtime dots; Today ring wired to /api/day.
  - verify: Yesterday's totals sum to 86,400 s; filling a gap moves seconds from unknown to the chosen category immediately and after a re-rollup; `wrangler tail` shows the cron completing under the CPU limit; Week view compares correctly across a month boundary and DST change; a day with no data shows 'no data', not 24 h unknown, in averages.
- **M6 - Mac screen time**: ~/bin/screentime_push.py, Keychain token, LaunchAgent, Full Disk Access for /usr/bin/python3, /api/screentime with window replace, app_categories seeded from posted apps, Settings > Mac apps category editor, Mac intervals and app-category tint in the day chart, study blocks annotated with top apps.
  - verify: Within 65 minutes of loading the agent, the last hour appears as Mac blocks; per-hour Mac seconds never exceed 3600; killing the script mid-run and re-running produces no duplicate rows; recategorising VS Code to 'dev' recolours past days after rollup; log files show no auth or FDA errors for a week.
- **M7 - Phone fallback, polish, stretch**: `planner screentime phone` plus the /screentime skill for pasted iPhone Screen Time screenshots; 'phone' layer and per-app daily list in the day detail; freshness line and Unknown nudges; Wake Lock toggles; streak surfaces in the wind-down notification; export/backup docs; optional Shortcuts Alarm -> wake automation; stretch: aw-import-screentime reading Biome App.InFocus/remote to replace screenshots.
  - verify: A pasted Day-view screenshot yields hourly phone blocks that sum to the screenshot's daily total within 5 minutes; those hours only fill minutes not already claimed by Mac/study/sleep; the app shows a 'phone: none today' hint when nothing was posted; the alarm automation closes the sleep row on a real morning.

## RISKS
- NFC on a locked-but-awake iPhone is unsettled across sources: plan the gesture as raise -> Face ID -> tap, test once, and keep 'Notify When Run' on for the first days; iOS updates have flipped 'Run Immediately' back to 'Ask' in the past, so re-check after every update.
- Personal automations do not sync via iCloud and are lost with the phone; the six automations must be recreated by hand (Settings > Shortcut setup page documents the slugs and URL).
- knowledgeC.db '/app/inFocus' and '/app/usage' are undocumented and Apple could drop them in any macOS release (most streams already moved to Biome); the script degrades gracefully (posts nothing, logs a warning) and ActivityWatch is the fallback source.
- Full Disk Access for a bare /usr/bin/python3 relied on a picker that was broken in macOS 26.1-26.2; verify with the TCC query, and if it fails wrap the script in a signed .app bundle as Apple DTS recommends.
- Workers Free gives 10 ms CPU per invocation including cron; the day computation is bounded (1440 cells, a few hundred rows) but /api/summary must never recompute more than 3 non-final days per request and the sync pull must stay at <= 1000 rows.
- D1 100k row writes/day counts index writes; the design stays around 5k/day, but a runaway Mac script loop or an outbox retry storm could burn the quota until 00:00 UTC (hard-enforced since Sept 2026): the Worker caps windows at 48 h and the client caps outbox batches.
- APP_TOKEN in the browser: anyone with the phone unlocked can read it, and Safari's ITP could purge script storage if the installed app is unused for 7 days of Safari use; the token is mirrored in IndexedDB and simply re-pasted from the password manager if lost. Cloudflare Access was not chosen because its free tier may demand a card.
- Open Food Facts data is crowd-sourced and often incomplete; the app always shows fetched numbers for review before logging, and OFF v2/v3 search is never used (search is USDA only).
- Camera in installed web apps on iOS 26/27 has an unfixed rotation bug, so barcode scanning uses a still photo via file input; that is one extra tap and permission may be prompted per launch.
- Bed/wake inference has edge cases (naps, late-night re-taps, forgetting the morning tap); the state machine covers the common ones and Today always offers a manual fix, but the first weeks will need the sleep row edited occasionally.
- Unknown-gap fatigue: if Mac data is absent (Mac asleep) and no phone data is pasted, days are mostly Unknown; the chart must make filling cheap (previous/next block buttons) and the week view must show unknown honestly rather than hide it.
- Cron runs in UTC; '0 9 * * *' drifts by an hour across DST, which is harmless for a rollup but should not be used for anything user-facing (the wind-down reminder is a local Shortcuts automation for this reason).
- Claude Code reading digits off a label or a Screen Time screenshot can misread; the 4/4/9 check and the 'from Claude' badge catch gross errors but not a 6/8 swap on a single macro, so the user should glance at new foods once.

## OPEN QUESTIONS
- Timezone to seed settings.tz (the cron default 09:00 UTC assumes US Eastern) and whether you ever travel enough to want per-day timezone capture.
- Weight unit for lifting (kg or lb) and the default stepper increment (2.5 kg / 5 lb).
- Calorie and macro targets, and whether they differ on training vs rest days (schema supports one set; a per-weekday map is a small change).
- Bed target time, wind-down lead (45 min) and wake target; is 15 minutes the right grace for the streak?
- Should the nightstand sticker double as the wake sticker (tap again in the morning), or do you prefer the Shortcuts Alarm automation ('when alarm is stopped') as the wake signal?
- Should 'Morning run' count as a workout block (30 min default) or do you want to time runs as real workouts/sessions?
- Is the fixed category list for gap filling right (sleep, workout, study, routine, meal, chores, social, commute, rest, phone, other), and which Mac app categories do you want (dev, work, comms, browsing, media, social, other)?
- Should Claude Code use the APP_TOKEN via the Keychain-backed CLI (proposed) or do you want a fourth, narrower CLI_TOKEN that cannot read history?
- Do you want a desk NFC sticker that starts/stops a study session for a default project (one more automation, sessions.source 'shortcut' is already in the schema)?
- Are you willing to turn on Screen Time 'Share Across Devices' so the Biome/aw-import-screentime stretch can replace the screenshot fallback for iPhone usage later?
- Do you want meal markers on the timeline (proposed) or meals as time blocks with a default duration?
- Custom domain on the Worker or is planner.<subdomain>.workers.dev fine (it affects the URL written to the stickers and the Shortcut)?
