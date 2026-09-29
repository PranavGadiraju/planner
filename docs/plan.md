# Daily Life Planner — implementation plan

## Context

You want one free place, usable from your iPhone and your Mac, that tracks meals and calories (presaved meals, foods weighed in grams with label values), workouts (every set logged live, past sessions easy to browse), study and side-project sessions (how long, what got done), a morning routine checked off by tapping NFC stickers, bedtime, and a 24-hour "spending tracker for time" chart that fills itself in as much as possible from Mac screen time and your logs, with Unknown gaps you can fill by tapping. You are visual and want to see results.

Decisions you made in this session:

| Topic | Decision |
|---|---|
| Phone / Mac | iPhone XS or newer (iOS 26/27); macOS 26.6.2, timezone America/New_York |
| Where it runs | A web app you own, in a folder you keep; free hosting and database |
| Accounts on hand | GitHub (logged in as PranavGadiraju), Cloudflare, Supabase, Google |
| Time chart | Mac script reading macOS Screen Time data + your logs |
| Food entry | Type label values, plus barcode scan / name search |
| Workouts | Named templates (Push/Pull/Legs), pre-fill from last session, progress charts. No rest timer, no import |
| Bedtime | Target bedtime + wind-down reminder + nightstand sticker |
| Sticker taps | First tap starts an item, second tap finishes it (real durations); single tap still works with a default length |
| Wake signal | The first routine-sticker tap of the morning (you had to get out of bed to tap it) |
| Data | Start fresh |

Research and a three-design panel were run and fact-checked before this plan; the verified facts it relies on are stated inline.

## Stack (verified 2026-09-28)

**One Cloudflare Worker on the free plan** serves the PWA as static assets and a small JSON API under `/api/*`, backed by **D1 (SQLite)**, with **one Cron Trigger** for the nightly rollup. No credit card, nothing pauses or sleeps. Limits that shape the design: 100k requests/day, 10 ms CPU per invocation (cron included), D1 100k row writes/day and 5M reads/day, 5 cron triggers per account, cron runs in UTC, D1 7-day Time Travel restore. Deploy with `npx wrangler deploy` from the Mac; the repo lives on GitHub for backup.

Why not the others: Supabase free projects pause after 7 days of low use and every NFC/Mac POST then fails until you click Resume; Firebase Spark has no free scheduler and a Shortcut would need two calls per tap; Cloudflare Access login may ask for a card, so login is a token.

**Auth:** three long random bearer tokens stored as Worker secrets (`wrangler secret put`), compared with a constant-time check:
- `APP_TOKEN` — pasted once into Settings, kept in localStorage (mirrored in IndexedDB); full read/write.
- `SHORTCUT_TOKEN` — pasted once into the iOS Shortcut; may only call `POST /api/tap`.
- `MAC_TOKEN` — in the macOS Keychain, read by the screen-time script; may only call `POST /api/screentime` with source `mac`.
Plus `USDA_KEY` as a Worker secret so the USDA key never reaches the phone. The static site contains no secrets. Every token rotates independently.

**Frontend:** TypeScript + Vite + Preact + `@preact/signals`, hash routing, installable PWA via `vite-plugin-pwa` (generateSW, precache the shell, `/api/*` NetworkOnly, autoUpdate with a "Reload for update" toast). Charts are hand-written inline SVG. Persistence is a **thin sync** (not a full sync engine): network-first reads with an IndexedDB cache of API responses (`idb-keyval`), plus an ordered **outbox** of idempotent upserts that flushes on launch, on `online`, on `visibilitychange`, and after every write. iOS has no Background Sync, so the Shortcut and the Mac script always post directly to the Worker and never depend on the PWA being open. Every synced table carries `updated_at` and `deleted_at`; upserts are `ON CONFLICT DO UPDATE ... WHERE excluded.updated_at > updated_at`, deletes are tombstones, so a stale outbox replay can never revert a newer edit made on the other device.

iOS specifics baked in (verified): `viewport-fit=cover` + `env(safe-area-inset-*)` padding, 16 px inputs, solid status bar (black-translucent is deprecated and broken on iOS 26.1+), `navigator.storage.persist()` once at boot (auto-granted for home-screen apps), Wake Lock while a timer view is visible, timers rendered from absolute timestamps and recomputed on `visibilitychange`, label/barcode photos via `<input type=file capture>` (getUserMedia has an unfixed rotation bug in installed web apps), barcode decoding with the `barcode-detector` ponyfill on a still photo with the zxing-wasm binary self-hosted as a Vite asset (native BarcodeDetector is disabled on iOS Safari). No deep-linking into an installed iOS web app exists, so nothing ever tries to open the app from a Shortcut.

**Nutrition data:** Open Food Facts v3 product-by-barcode fetched directly from the browser (CORS open; gate on `nutriments['energy-kcal_100g']`, fall back to `energy_100g/4.184`, never trust `status` alone because placeholder products exist), then USDA Branded by GTIN via the Worker. Name search goes to USDA FoodData Central through `GET /api/lookup/search` (OFF text search is unreliable). USDA mapping: nutrient ids 1008 kcal, 1003 protein, 1005 carbs, 1004 fat, 1079 fiber, 2000 then 1063 sugars; de-duplicate repeated ids by first occurrence; `Foundation,SR Legacy` for generic foods, `Branded` for packaged. All foods stored per 100 g; label entry accepts per-serving + serving grams or per-100 g directly; 4/4/9 check flags (never blocks) when |4P+4C+9F − kcal| > 15% of kcal or 25 kcal at small servings.

**Your Mac today:** Node 23.5, npm 11, Python 3.13 (Homebrew) and `/usr/bin/python3` 3.9.6 (Xcode installed), git 2.50, `gh` logged in, wrangler not yet installed (npx fetches it). Screen Time folders are unreadable from a normal shell until Full Disk Access is granted, as expected.

## Repo layout

```
planner/
  wrangler.jsonc          # assets ./dist, run_worker_first ["/api/*"], D1 binding DB, vars TZ, crons ["5 8 * * *"]
  schema.sql              # D1 DDL below
  src/worker/             # index.ts (router, auth, roles), routes/*.ts, day.ts (buildDay), sleep.ts, rollup.ts, cron.ts
  src/shared/             # types.ts, tz.ts (local day / midnight via Intl), sleep.ts (state machine shared with the app)
  src/app/                # Preact PWA: main.tsx, router, screens/*, components/charts/*, data/{api,outbox,cache}.ts, styles
  public/                 # manifest, icons 180/192/512, zxing-wasm asset
  mac/screentime_push.py  # hourly launchd script (symlinked to ~/bin)
  mac/com.pranav.planner-screentime.plist
  mac/backup.plist        # weekly wrangler d1 export
  bin/planner             # zero-dependency Node CLI used by Claude Code
  CLAUDE.md               # recipes for label photos, screenshots, text logging
  .claude/skills/{label,screentime}/SKILL.md
  README.md               # setup: wrangler login, secrets, FDA, Shortcuts, stickers
  test/                   # vitest: buildDay (DST, overlaps), sleep/routine state machines, nutrition math
```

First implementation step: move this session into a new folder (`~/Desktop/planner`, created via the app's folder tools), `git init`, then push to a **private** GitHub repo (`gh repo create planner --private`) after you confirm the repo name.

## Data model (D1 DDL, the core contract)

Conventions: ids are client-generated UUIDs; every `*_at`/`ts` column is ISO-8601 UTC text; `local_day` is `YYYY-MM-DD` in `settings.tz` computed with Intl in the Worker or app (never SQLite `localtime`); synced tables have `updated_at` (client clock, last-writer-wins) and `deleted_at` (tombstone); server-only tables may be hard-deleted.

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
-- seeded: tz "America/New_York", targets {kcal,protein_g,carb_g,fat_g}, bed_target "23:00", winddown_min 45,
--         late_grace_min 15, weight_unit "lb", routine_default_min per item, app category seed map

-- FOOD (all per 100 g)
CREATE TABLE foods (id TEXT PRIMARY KEY, name TEXT NOT NULL, brand TEXT,
  source TEXT NOT NULL CHECK (source IN ('label','off','usda','claude')), source_id TEXT,  -- barcode | fdcId
  kcal_100 REAL NOT NULL, protein_100 REAL NOT NULL DEFAULT 0, carb_100 REAL NOT NULL DEFAULT 0,
  fat_100 REAL NOT NULL DEFAULT 0, fiber_100 REAL, sugar_100 REAL,
  serving_g REAL, serving_text TEXT, label_json TEXT,        -- raw label numbers for audit
  use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX ix_foods_source ON foods(source, source_id);

CREATE TABLE meals (id TEXT PRIMARY KEY, name TEXT NOT NULL, total_g REAL NOT NULL DEFAULT 0,
  kcal REAL NOT NULL DEFAULT 0, protein_g REAL NOT NULL DEFAULT 0, carb_g REAL NOT NULL DEFAULT 0,
  fat_g REAL NOT NULL DEFAULT 0, fiber_g REAL, sugar_g REAL,   -- denormalised totals at scale 1.0
  default_slot TEXT CHECK (default_slot IN ('breakfast','lunch','dinner','snack')),
  use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE meal_items (id TEXT PRIMARY KEY, meal_id TEXT NOT NULL REFERENCES meals(id),
  food_id TEXT NOT NULL REFERENCES foods(id), grams REAL NOT NULL, position INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX ix_meal_items_meal ON meal_items(meal_id);

CREATE TABLE food_log (id TEXT PRIMARY KEY, ts TEXT NOT NULL, local_day TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('breakfast','lunch','dinner','snack')),
  food_id TEXT REFERENCES foods(id), meal_id TEXT REFERENCES meals(id), grams REAL, scale REAL,
  label TEXT NOT NULL, kcal REAL NOT NULL, protein_g REAL NOT NULL DEFAULT 0,   -- SNAPSHOT: food edits never rewrite history
  carb_g REAL NOT NULL DEFAULT 0, fat_g REAL NOT NULL DEFAULT 0, fiber_g REAL, sugar_g REAL, note TEXT,
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','cli')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
  CHECK (food_id IS NOT NULL OR meal_id IS NOT NULL));
CREATE INDEX ix_food_log_day ON food_log(local_day);

-- LIFTING
CREATE TABLE exercises (id TEXT PRIMARY KEY, name TEXT NOT NULL, muscle TEXT,
  load_type TEXT NOT NULL DEFAULT 'weight' CHECK (load_type IN ('weight','bodyweight')),
  weight_step REAL NOT NULL DEFAULT 5, use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE workouts (id TEXT PRIMARY KEY, name TEXT,          -- 'Push' | 'Pull' | 'Legs' ... template name
  started_at TEXT NOT NULL, ended_at TEXT, local_day TEXT NOT NULL, note TEXT,
  ended_by TEXT CHECK (ended_by IN ('user','auto')),           -- auto = closed after 3 h, badged in the UI
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX ix_workouts_day ON workouts(local_day);
CREATE TABLE sets (id TEXT PRIMARY KEY, workout_id TEXT NOT NULL REFERENCES workouts(id),
  exercise_id TEXT NOT NULL REFERENCES exercises(id), set_no INTEGER NOT NULL,
  reps INTEGER NOT NULL, weight REAL NOT NULL DEFAULT 0, is_warmup INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX ix_sets_workout ON sets(workout_id, exercise_id, set_no);
CREATE INDEX ix_sets_exercise_ts ON sets(exercise_id, ts);

-- PROJECTS / STUDY
CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project','study')), color TEXT,
  position INTEGER NOT NULL DEFAULT 0, archived_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  started_at TEXT NOT NULL, ended_at TEXT, local_day TEXT NOT NULL, duration_s INTEGER,
  note TEXT,                                                    -- 'what got done'
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','cli','suggest')),
  ended_by TEXT CHECK (ended_by IN ('user','auto')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX ix_sessions_day ON sessions(local_day);
CREATE INDEX ix_sessions_project ON sessions(project_id, started_at);
CREATE TABLE checkins (local_day TEXT PRIMARY KEY, morning_at TEXT, morning_note TEXT,
  evening_at TEXT, evening_note TEXT, updated_at TEXT NOT NULL, deleted_at TEXT);   -- one line each, no ratings

-- ROUTINE (NFC): first tap starts, second tap (>= 3 min later) ends
CREATE TABLE routine_items (id TEXT PRIMARY KEY,               -- slug the Shortcut sends
  name TEXT NOT NULL, icon TEXT, position INTEGER NOT NULL DEFAULT 0,
  default_min INTEGER NOT NULL DEFAULT 10,                     -- used when only one tap happened
  chart_category TEXT NOT NULL DEFAULT 'routine' CHECK (chart_category IN ('routine','workout')),
  active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, deleted_at TEXT);
-- seed: shower 15 routine | run 40 workout | stretch 10 routine | shoulders 10 routine | journal 10 routine
CREATE TABLE routine_log (local_day TEXT NOT NULL, item_id TEXT NOT NULL REFERENCES routine_items(id),
  started_at TEXT NOT NULL, ended_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('nfc','app','cli')),
  updated_at TEXT NOT NULL, deleted_at TEXT, PRIMARY KEY (local_day, item_id));   -- PK = idempotent per item per day

-- SLEEP
CREATE TABLE sleep (night_of TEXT PRIMARY KEY,                  -- local date of (bed_ts - 12 h)
  bed_ts TEXT NOT NULL, wake_ts TEXT,
  bed_source TEXT NOT NULL CHECK (bed_source IN ('nfc','app','cli')),
  wake_source TEXT CHECK (wake_source IN ('routine','nfc','app','cli')),
  target_bed TEXT NOT NULL, late_min INTEGER NOT NULL DEFAULT 0,   -- snapshot of the target that night; streak = late_min <= grace
  updated_at TEXT NOT NULL, deleted_at TEXT);

-- MANUAL TIME BLOCKS (gap filling; always win on the chart)
CREATE TABLE time_blocks (id TEXT PRIMARY KEY, start_ts TEXT NOT NULL, end_ts TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('sleep','workout','study','routine','meal','chores','social','commute','rest','phone','other')),
  label TEXT, project_id TEXT REFERENCES projects(id),
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','cli')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, CHECK (end_ts > start_ts));
CREATE INDEX ix_time_blocks_start ON time_blocks(start_ts);

-- SCREEN TIME (server-only; written by the Mac script and the CLI)
CREATE TABLE screen_hours (source TEXT NOT NULL CHECK (source IN ('mac','phone')), device TEXT NOT NULL,
  hour_start TEXT NOT NULL,                                     -- UTC hour start; never 'local hour unix'
  app_id TEXT NOT NULL,                                         -- bundle id, or '_total' for phone hours
  seconds INTEGER NOT NULL CHECK (seconds BETWEEN 0 AND 3600), updated_at TEXT NOT NULL,
  PRIMARY KEY (source, device, hour_start, app_id));
CREATE INDEX ix_screen_hours_hour ON screen_hours(hour_start);
CREATE TABLE screen_intervals (source TEXT NOT NULL, device TEXT NOT NULL,
  start_ts TEXT NOT NULL, end_ts TEXT NOT NULL, top_app TEXT, updated_at TEXT NOT NULL,
  PRIMARY KEY (source, device, start_ts), CHECK (end_ts > start_ts));   -- merged focus runs for precise placement
CREATE TABLE app_categories (app_id TEXT PRIMARY KEY, label TEXT,
  category TEXT CHECK (category IN ('dev','work','comms','browsing','media','social','other')),   -- NULL = needs triage
  seen_seconds INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, deleted_at TEXT);

-- ROLLUPS + OPS
CREATE TABLE day_summary (local_day TEXT PRIMARY KEY, sleep_s INTEGER NOT NULL DEFAULT 0,
  workout_s INTEGER NOT NULL DEFAULT 0, study_s INTEGER NOT NULL DEFAULT 0, routine_s INTEGER NOT NULL DEFAULT 0,
  mac_s INTEGER NOT NULL DEFAULT 0, phone_s INTEGER NOT NULL DEFAULT 0, manual_s INTEGER NOT NULL DEFAULT 0,
  unknown_s INTEGER NOT NULL DEFAULT 0, tracked_s INTEGER NOT NULL DEFAULT 0,
  mac_by_category TEXT NOT NULL DEFAULT '{}', study_by_project TEXT NOT NULL DEFAULT '{}',
  manual_by_category TEXT NOT NULL DEFAULT '{}', kcal REAL, protein_g REAL, carb_g REAL, fat_g REAL,
  sets_count INTEGER NOT NULL DEFAULT 0, volume REAL NOT NULL DEFAULT 0, sessions_count INTEGER NOT NULL DEFAULT 0,
  routine_done INTEGER NOT NULL DEFAULT 0, routine_total INTEGER NOT NULL DEFAULT 0, bed_late_min INTEGER,
  final INTEGER NOT NULL DEFAULT 0, computed_at TEXT NOT NULL);
CREATE TABLE dirty_days (local_day TEXT PRIMARY KEY, marked_at TEXT NOT NULL);   -- any write touching a past day
CREATE TABLE tap_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, item TEXT NOT NULL,
  role TEXT NOT NULL, result TEXT NOT NULL);                    -- every /api/tap incl. duplicates and rejects
CREATE TABLE automation_health (source TEXT PRIMARY KEY,        -- 'mac' | 'nfc' | 'cli' | 'cron'
  last_ok_at TEXT, last_error_at TEXT, last_error TEXT, detail TEXT);
```

## API (Worker)

| Method + path | Role | Purpose |
|---|---|---|
| GET /api/health | none | liveness; used when setting up the Shortcut |
| GET /api/me | app | validate token; returns tz, server time, today |
| POST /api/tap | shortcut, app | single ingest for every sticker: `{item}`; server-timestamped for the shortcut role; routine start/finish + sleep state machine; unknown items → 400; every call appended to `tap_log`; returns `{ok, action, message}` e.g. "Run started 06:52" / "Run done 41 min" / "In bed 23:20 (+20)" |
| POST /api/write | app | batched idempotent upserts `{mutations:[{table,rows}]}` (max 200 rows) with the `updated_at` guard; marks `dirty_days` for past days |
| GET /api/day/:date | app | live 24-hour timeline + totals + gaps + meal markers + freshness |
| GET /api/today | app | Today payload: routine state, sleep card, running timers, health strip, ring totals |
| GET /api/foods, /api/meals, /api/exercises, /api/projects | app | lists (plus recent history slices used for pre-fill) |
| GET /api/workouts?limit, GET /api/workouts/:id, GET /api/exercise/:id/history | app | history and progress data |
| GET /api/sessions?from&to, GET /api/projects/:id/log | app | study sessions and the per-project changelog of notes |
| GET /api/lookup/barcode/:code | app | USDA Branded by GTIN (fallback after the browser's direct OFF call) |
| GET /api/lookup/search?q&type | app | USDA search with the Worker-held key |
| POST /api/foods, /api/food-log, /api/sessions, /api/sets, /api/time-blocks | app (CLI) | Claude Code helpers; `/api/foods` converts per-serving to per-100 g and returns 4/4/9 warnings |
| POST /api/screentime | mac (source mac), app (source phone) | `{source, device, window, hours[], intervals[], apps[]}`; window delete-and-replace only when the row count is plausible (script aborts on zero rows); unseen bundle ids inserted with NULL category |
| GET /api/summary?from&to | app | `day_summary` rows; at most 3 non-final days recomputed per request, others `stale:true` |
| POST /api/rollup {day}, POST /api/cron/run | app | manual rebuild / manual cron for verification |
| GET /api/tap/log, GET /api/health/automations, GET /api/export | app | debugging and backup |
| cron `5 8 * * *` (04:05 EDT) | — | rollup D-1 and D-2, drain `dirty_days`, set `final=1` for days ≥ 2 days old, auto-close workouts/sessions open > 3 h (`ended_by='auto'`), prune `tap_log` to 500 rows. SQL aggregation only, no JS loops over thousands of rows (10 ms CPU) |

Past-day writes also rebuild that day's summary in `ctx.waitUntil`, so week totals never go stale after a gap fill.

## Core algorithms

**Routine taps (`POST /api/tap` with a routine item).** Key `(local_day, item_id)`. No row → insert `started_at = now`. Row with `ended_at` NULL: if `now − started_at < 2 min` → duplicate (no change); if `≥ 3 min` → set `ended_at = now`; between → ignored. Row with `ended_at` set → "already done" (no change). A tap 3 h or more after `started_at` is also "already done" (the 3 h cap: an item counts as done 3 h after it started even without a second tap, and the chart keeps drawing it as `started_at + default_min`). The app can edit either time or undo (tombstone; a later tap re-activates). The first routine tap of a local day also closes an open sleep row whose `bed_ts` is ≥ 3 h earlier (`wake_source='routine'`), which is your chosen wake signal.

**Sleep (`item = bed`, shared `sleep.ts` used by the Worker and the in-app buttons).** `night_of` = local date of `now − 12 h`. No row → insert `bed_ts=now`, `target_bed` snapshot, `late_min` = minutes after the target instant (target before 12:00 means the next calendar day); except that a tap between 10:00 and 17:59 local with no open row is ignored (`bed_daytime_ignored`: a daytime tap would make a nonsense `night_of`, so naps are logged in the app, not with the sticker). Open row: re-tap < 10 min → duplicate; 10 min–3 h → ignored (the first bedtime stands, which is the honest number); ≥ 3 h → `wake_ts=now` (nightstand re-tap as a fallback wake). Row already closed and local hour ≥ 18 → the earlier interval becomes a `time_blocks` nap and the row restarts. If no wake arrives, Today shows a "When did you wake?" chip and the chart draws a dashed `sleep?` block to `bed + 8 h`; an unconfirmed night breaks the streak until edited.

**Day chart `buildDay(D)` (pure function in `src/worker/day.ts`, unit-tested).** Window = local midnight of D to local midnight of D+1 via Intl, `N` minutes (1380/1440/1500 on DST days); minutes after now are FUTURE on today. A `Uint8Array(N)` of categories plus a label array; `fill(start,end,cat,label)` only writes still-UNKNOWN minutes, so **call order is precedence and nothing is ever double-counted**: 1 manual `time_blocks` (always win), 2 sleep, 3 workouts (`ended_at ?? min(now, start+3h)`), 4 study sessions (detail lists the top Mac apps inside the range), 5 routine (`started_at → ended_at ?? started_at + default_min`, category per item, run = workout), 6 Mac `screen_intervals` (tinted by `app_categories[top_app]`), 7 Mac `screen_hours` walk for hours without intervals (fill `min(round(sum/60),60)` minutes from the hour start), 8 phone `_total` hours (take what is left of the hour), 9 remaining = UNKNOWN. Run-length encode into blocks; UNKNOWN runs under 5 min are absorbed into the previous block for display only; runs ≥ 5 min become tappable gaps. Totals per category, `mac_by_category` and `study_by_project` come from the raw seconds tables, not from tinted cells. Assert the runs sum to exactly N in tests, including both DST days.

**Rollups.** Week = Mon–Sun in `settings.tz`; the client sums `day_summary` columns and JSON maps; the current week compares Mon–today against the same days of last week ("so far"). Days with `tracked_s = 0` are "no data" and excluded from averages. Bedtime rollups: nights on target, average late minutes, current streak.

**Pre-fill for sets.** Set N of exercise E pre-fills from the last same-name workout's set N of E; else from set N-1 of this workout; else from E's last logged set ever. PR = Epley e1RM beats history (warm-ups excluded from PRs and volume).

## Screens (phone first; the Mac uses the same app at ≥ 900 px with a sidebar)

- **Today** — date + sync dot (green synced / amber outbox pending / red no token); day ring (24 segments coloured by category, Unknown hatched) with "tracked / unknown"; routine row of 5 large circles (in progress = ring, done = filled with time; tap = start/finish now via outbox; long-press = edit time / undo); sleep card ("In bed 23:20 (+20) · up 6:52 · 7h32 · streak 4", big **In bed** after 20:00, "When did you wake?" chip when open); running strip for a workout/session with End; quick actions Start workout / Start session / Log meal; one-line AM/PM check-in cards (dismissible, PM pre-filled with today's sessions, hours per project, routine n/5); **automation health strip** ("Mac last pushed 4 h ago", "no sticker taps yet today" after 11:00, "phone: none today", outbox pending, "n apps to categorise"). Refresh button in the top bar and refresh on return (`visibilitychange`).
- **Food** — kcal bar + P/C/F bars vs targets; quick-add grid of the top 6 presaved meals: **tap = log 1x in the inferred slot with an Undo toast, long-press = portion sheet** (0.5x/1x/1.5x/2x/grams, slot chips); search over local foods/meals first, "More (USDA)" link; log list grouped by slot: tap to edit or delete (Delete has an Undo toast); Select to save as meal.
- **Add food** — Scan (still photo → ponyfill → OFF v3 → USDA GTIN → candidate card with editable numbers → Log now / Save only), Search (USDA generic by default, Branded toggle), Label (name, brand, per-serving + serving grams **or** per-100 g mode, live per-100 preview, 4/4/9 chip). Grams pad with chips 1 serving / 50 / 100 / 150 / 200.
- **Meal builder** — items with grams, running totals, duplicate, soft delete.
- **Lift** — template chips (last 5 distinct workout names + Empty): tap "Push" creates a workout pre-populated with the last Push session's exercise list; history grouped by month ("Push · Tue 24 Sep · 52 min · 18 sets · 7,420 lb") with session detail and "Repeat this"; exercise library sorted by use.
- **Active workout** — exercise pager (swipe), ghost line "Last: 135×8, 135×8, 135×7", PR line, weight/reps steppers (step = `weight_step`, tap number for a pad), full-width 64 px **LOG SET n** button that re-arms for the next set, logged sets list with PR badge, warm-up toggle, Add exercise (picker over existing names with explicit "Create new" to stop typo fragmentation), Finish summary toast, auto-close badge, Keep-screen-on toggle.
- **Exercise progress** — e1RM line with PR dots, volume bars, range chips, last 10 sessions table, merge duplicates.
- **Work** — running banner with End → one auto-focused "What got done?" line + editable duration; project rows with a Start button; "+ Manual" with 25/50/90 chips; today's sessions; weekly per-project bars; **per-project changelog** of notes over time.
- **Day / Week / Month** — day: category strip + vertical 24 h timeline (1 px = 1 min, auto-scrolled to now) with coloured blocks, meal markers, tap block = detail sheet (source, times, top apps, edit/delete/split), tap gap = Fill sheet (category chips incl. study + project, "Same as previous/next block", start / end time inputs — no drag handles); week: 7 stacked columns + totals with deltas vs last week + bedtime dots vs target line; month: category shares, unknown share per day, per-project hours. Freshness line at the bottom.
- **Settings** — token paste + Test; tz, weight unit, targets, bed target, wind-down minutes, grace; routine items editor; **Shortcut setup page** (exact URL, slugs, step-by-step); projects/exercises links; Mac app categories triage list ordered by seen seconds; NFC tap log; automation health; Force sync; Export; Reset cache; install hints.

## Automations

**NFC stickers → Shortcuts (recipe goes in README and the Settings page).** Buy a 10-pack of plain NTAG213 25 mm stickers (about $5–10); do **not** write URL records to them. One Shortcut "Planner Tap": Get Contents of URL → POST `https://planner.<sub>.workers.dev/api/tap`, header `Authorization: Bearer <SHORTCUT_TOKEN>`, JSON body `item = Shortcut Input`; then Get Dictionary Value `ok` → If not true → Show Notification "Planner failed: <item>" (Get Contents of URL does not fail on a 4xx body, so this is the only way a broken token or typo is visible); optional success banner with the server message. Run it once manually with input `shower` and choose Always Allow. Six NFC personal automations (shower, run, stretch, shoulders, journal, bed): Run Immediately, Notify When Run on for the first week; each runs Planner Tap with the slug as input. Shortcuts keys on the tag UID. Gesture: raise phone (Face ID), touch the top edge to the sticker about 1 s; nothing opens. Screen must be on and the phone unlocked once since boot; locked-but-awake is disputed, so test once. Automations do not sync via iCloud; re-check Run Immediately after iOS updates.

**Bedtime.** Shortcuts Time-of-Day automation at `bed_target − winddown_min` (Show Notification "Wind down, bed by 23:00"; optionally run Planner Tap with `winddown` to get the streak in a second notification). Edited by hand when the target changes (Settings reminds you).

**Mac screen time (`mac/screentime_push.py`, `/usr/bin/python3`, stdlib only).** Hourly LaunchAgent (`StartCalendarInterval Minute=5`, `RunAtLoad`, logs under `~/Library/Logs/`, no secrets in the plist). Copies `knowledgeC.db` + `-wal` + `-shm` to a temp dir, opens the copy read-only, reads `/app/usage` rows (verified stream; `/app/inFocus` tried first and logged as an experiment, falling back on suspiciously low coverage) for `ZSOURCE.ZDEVICEID IS NULL`, window = `[max(watermark − 3 h, now − 26 h), now)`, splits at UTC hour boundaries into per-app seconds (clamped to 3600, dock/loginwindow ignored) and unions all apps into focus intervals with a 120 s gap tolerance and a `top_app`; resolves new bundle ids to names with `mdfind`; **aborts without posting when the copy yields zero rows**; POSTs one body with `MAC_TOKEN` from the Keychain (`security find-generic-password -s planner-mac-token -w`; first run prompts Always Allow); writes the watermark only on 2xx. Full Disk Access for `/usr/bin/python3`: drag it into the list (the + picker was broken on 26.1–26.2) and verify with the one-line sqlite read test and the TCC.db query. The Screen Time store (RMAdminStore) is EPERM on macOS 26.3+ even with FDA and is never touched. iPhone usage: later stretch via the Biome `App.InFocus/remote` streams (aw-import-screentime decoder; needs Share Across Devices); until then, paste an iPhone Screen Time screenshot into Claude Code.

**Backups.** Weekly LaunchAgent runs `npx wrangler d1 export planner --remote --output ~/planner-backups/<date>.sql`; `GET /api/export` for a JSON dump; D1 Time Travel covers 7 days.

## Claude Code helpers

`bin/planner` (Node, zero deps) reads the URL from `~/.config/planner/config.json` and `APP_TOKEN` from the login Keychain (`planner-app-token`), never prints it. Commands: `food add --json`, `food search`, `eat --food|--meal --grams|--scale [--at] [--slot]`, `session add --project --minutes|--start/--end --note [--day]`, `set add --workout|--new "Push" --exercise --reps --weight [--sets 3]` (log sets from text or a notebook photo), `block add --from --to --category [--label] [--project]`, `screentime phone --day --hours '{"7":12,...}'` (local hours → UTC `_total` rows; unreadable hours omitted; grey/unattributed time is Unknown, never phone use; Most Used never spread across hours), `tap <item>`, `day [date]` (prints totals and the ribbon as text so I can answer "how did yesterday go"), `rollup`, `export`. `CLAUDE.md` holds the label recipe (serving grams, ask for weighed grams when only a household measure is printed, per-100 math, 4/4/9 check, show the table, confirm before posting, never invent digits) and the screenshot recipe; `.claude/skills/label` and `.claude/skills/screentime` wrap them as slash commands. Foods added this way carry a "from Claude" badge in the app.

## Build order (each milestone is usable on its own)

1. **M1 Skeleton + stickers + sleep + Today + Settings (usable tomorrow morning).** Repo, `wrangler.jsonc`, `schema.sql` applied local and remote, secrets set, Worker auth/roles, `/api/health`, `/api/me`, `/api/tap` with the routine and sleep state machines (shared module, unit-tested), `/api/write`, `/api/today`, `tap_log`, `automation_health`; PWA shell (Preact, manifest, service worker, outbox, token screen), Today (routine circles, sleep card, check-in one-liners) and Settings (token, routine editor, Shortcut setup page, tap log); deployed to workers.dev, installed on iPhone and Mac; README with the Shortcut recipe. *You:* `wrangler login`, buy stickers, create the Shortcut and 6 automations + the wind-down automation.
2. **M2 Minimal day ribbon.** `buildDay` with sleep, routine, manual blocks and Unknown (no Mac yet), `/api/day`, Day view timeline + gap Fill sheet, Today ring. The visual payoff arrives in week one.
3. **M3 Food.** foods/meals/food_log flows, Food tab, one-tap meal chips, Label form (both modes), Meal builder, USDA search route, `planner` CLI (`food add`, `eat`, `day`) + `CLAUDE.md` + `/label` skill.
4. **M4 Lift.** exercises/workouts/sets, template chips, Active workout with pre-fill rule and one-tap Log, PR detection, history, progress charts, auto-close; workout screen reads its pre-fill data from the IndexedDB response cache so poor gym signal is fine.
5. **M5 Work + check-ins.** projects/sessions, Work tab, running banner, End sheet, manual entry, per-project changelog, PM check-in pre-fill, `planner session add`, `set add`.
6. **M6 Mac screen time.** `screentime_push.py`, Keychain token, LaunchAgent, FDA grant + verification, `/api/screentime` window replace, app category triage list with the seeded map, Mac intervals and tint in the day chart, study blocks annotated with top apps, health strip wired. *You:* grant Full Disk Access.
7. **M7 Review + rollups.** `day_summary`, cron, `dirty_days`, `/api/summary`, `/api/rollup`, `/api/cron/run`, Week and Month views with deltas and bedtime dots, weekly backup LaunchAgent.
8. **M8 Barcode, phone fallback, polish.** Still-photo scan with the self-hosted ponyfill, OFF v3 → USDA GTIN chain, `planner screentime phone` + `/screentime` skill, phone layer on the chart, Mac-derived "Log 09:10–10:40 as <project>?" suggestions (dev apps ≥ 25 of 30 min outside any session), freshness nudges, optional desk sticker to start/stop a study session, optional Biome iPhone decoder stretch.

## Verification

- **Unit tests (vitest):** `buildDay` sums to exactly N minutes on a normal day and on both 2026 DST days; overlap test (study 10:00–11:00 + workout 10:30–11:30 → workout wins 10:30–11:30, nothing double-counted); routine state machine (start / duplicate / finish / already done); sleep state machine (bed, duplicate, ignored re-tap, wake at ≥ 3 h, nap conversion, first-routine-tap wake); nutrition math (per-serving → per-100, 4/4/9 flag, meal totals, snapshot on log).
- **Worker locally:** `wrangler dev` with `--local` D1; curl `/api/tap` twice with the shortcut token → one `routine_log` row, second response says duplicate; unknown item → 400 and a `tap_log` row; mac token on `/api/foods` → 403.
- **PWA in the built-in browser** at mobile viewport (375×812): Today above the fold, two-tap meal logging, one-tap set logging, timer elapsed correct after the tab is hidden 10 minutes, Add-to-Home-Screen manifest valid (Lighthouse PWA pass).
- **On your devices:** tap the shower sticker (locked-but-awake and unlocked) → circle turns to "in progress" on the next pull; second tap → done with duration; nightstand tap at night and first routine tap in the morning → sleep row with `late_min` and `wake_source='routine'`; airplane-mode in-app tap syncs on reconnect; a set logged on the phone appears on the Mac; kill the Mac script mid-run and re-run → no duplicate rows and per-hour seconds ≤ 3600; the previous hour on the ribbon roughly matches System Settings › Screen Time; `wrangler tail` shows the cron finishing under the CPU limit; week view is correct across a month boundary; a pasted Screen Time screenshot yields hourly phone blocks summing to the screenshot's total within 5 minutes and only filling minutes not already claimed.

## Things only you can do (I will tell you exactly when)

`wrangler login` (browser OAuth); confirm the private GitHub repo name; buy NTAG213 stickers; create the Shortcut and automations on the phone; grant Full Disk Access to `/usr/bin/python3` and accept the Keychain "Always Allow" prompt; sign up for a free USDA FoodData Central key (email only) and paste it with `wrangler secret put USDA_KEY`; optionally turn on Screen Time "Share Across Devices" for the later iPhone stretch.

## Risks and how the design handles them

- knowledgeC `/app/usage` is undocumented and could be dropped by Apple → ribbon degrades to Unknown; ActivityWatch is a drop-in replacement source for the same POST shape.
- NFC on a locked-but-awake phone is unsettled; iOS updates have flipped automations back to "Ask" → Notify When Run on for the first week, Shortcut-side failure notification, tap log, health strip, in-app circles as fallback.
- 10 ms CPU per invocation → `buildDay` is one pass over ≤ 1500 cells; summary recomputes ≤ 3 days per request; cron does SQL aggregation only.
- D1 100k writes/day counts index writes → Mac script posts ~35 rows/hour; windows capped at 48 h; outbox batches capped at 200.
- Single user on two devices with a stale outbox → `updated_at` guard + tombstones.
- OFF data is crowd-sourced and USDA Branded carries label rounding → fetched numbers are always shown for review before logging; label digits read by Claude get the 4/4/9 check and a "from Claude" badge.
- Sleep/routine inference has edge cases (naps, forgotten taps) → every inferred value is editable from Today and unconfirmed nights break the streak instead of faking it.
