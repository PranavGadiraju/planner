# planner - notes for Claude Code

Personal daily-life planner: a Preact + Vite PWA served by one Cloudflare Worker (free plan) with a JSON API under
`/api/*` backed by D1 (SQLite) and one Cron Trigger. Single user, two devices (iPhone + Mac). The approved plan is
`docs/plan.md`; read it before changing behaviour. `schema.sql` is the data contract and is final for the current
milestone.

## Layout

| Path | What |
|---|---|
| `src/worker/` | Worker: router, auth/roles, routes, day builder, cron |
| `src/app/` | Preact PWA (screens, charts, outbox/cache) |
| `src/shared/` | `types.ts`, `tz.ts` (local day via Intl), `routine.ts` and `sleep.ts` (state machines shared by Worker and app), `day.ts` (`buildDay`: the 24 h timeline behind `GET /api/day/:date`, the Day tab and `planner day`), `nutrition.ts` |
| `test/` | vitest for the shared modules and `buildDay` |
| `bin/planner` | zero-dependency Node CLI (this is how you talk to the deployed app) |
| `mac/` | screen-time push script, LaunchAgent plists, backup + install scripts |
| `.claude/skills/label`, `.claude/skills/screentime` | `/label` and `/screentime` recipes |

## Commands

```sh
npm run typecheck        # tsc -p tsconfig.json && tsc -p tsconfig.worker.json (TypeScript 7: no baseUrl, paths are tsconfig-relative)
npm test                 # vitest run
npm run dev:worker       # wrangler dev on :8787 (local D1; run `npm run db:local` once, and `npm run build` once so ./dist exists)
npm run dev              # vite on :5173, proxies /api to :8787
npm run deploy           # vite build && wrangler deploy
```

Run all three checks (`typecheck`, `test`, and a `--dry-run` / `--help` of any script you touched) before you say
you are done. After touching the Worker also run `bash scripts/smoke.sh` (isolated `wrangler dev` + curl of every
route with each token role); after touching `mac/` run `bash -n mac/*.sh`, `plutil -lint mac/*.plist` and
`/usr/bin/python3 -m py_compile mac/screentime_push.py`.

## Conventions that must hold

- TypeScript strict, `noUncheckedIndexedAccess`; no new npm dependencies without a strong reason.
- Every timestamp is ISO-8601 UTC text. `local_day` is computed with `localDay(now, tz)` from `src/shared/tz.ts`,
  never with SQLite `localtime` or `Date.getHours()`.
- Synced tables carry `updated_at` and `deleted_at`; writes are upserts guarded by
  `WHERE excluded.updated_at > table.updated_at`; deletes are tombstones. Ids are client-generated UUIDs.
- The routine and sleep state machines live in `src/shared/routine.ts` and `src/shared/sleep.ts` and are
  unit-tested; the Worker and the app call them, they never reimplement them.
- Workers free plan: 10 ms CPU per invocation. Aggregate in SQL; never loop over thousands of rows in JS.
- Roles: `app` (full), `shortcut` (only `POST /api/tap`), `mac` (only `POST /api/screentime`). 401 = bad token,
  403 = wrong role.

## Secrets: never print, never edit

Tokens live in Worker secrets (`wrangler secret put`), the login Keychain (`planner-app-token`,
`planner-mac-token`), the iOS Shortcut, and `.dev.vars` locally. Rules:

- Never `cat`, `echo`, log, or paste a token, and never put one on a command line (it lands in shell history).
- Never edit `.dev.vars`, Keychain items, or the plists' environment to add a token. If a token is missing,
  tell the user the exact command to run themselves (`security add-generic-password -U -a "$USER" -s planner-app-token -w`).
- `bin/planner` and `mac/screentime_push.py` read tokens internally and never print them; keep it that way.
- Do not run `wrangler secret put` or `wrangler login`; those are the user's.

## Using `bin/planner`

`node bin/planner <command>` (or `planner ...` if `bin/planner` is symlinked into `~/bin`). It reads the Worker URL
from `~/.config/planner/config.json` (`{"url": "..."}`, or `PLANNER_URL`) and the APP token from the Keychain (or
`PLANNER_TOKEN`). Exit codes: 0 ok, 1 network/auth/server error, 2 usage error.
Add `--json` when you need to parse the response instead of the pretty text.

Commands:

| Command | Use it to |
|---|---|
| `planner today` | answer "how is today going": routine circles, sleep + streak, running timers, automation health |
| `planner day [YYYY-MM-DD\|today\|yesterday]` | answer "how did yesterday go" (or any day): category totals as a small h m table, then one `HH:MM–HH:MM  category  label (source)` row per block, then the gaps. `today`/`yesterday` are the server's local day |
| `planner me` | check the URL + token work; prints tz and the server's idea of today |
| `planner health` | liveness and the automation_health rows (Mac push, NFC, cron) |
| `planner tap <item> [--at ISO]` | log a routine/bed/wake tap as the app role (same state machine as the stickers) |
| `planner taps` | last 100 tap_log rows to debug a sticker that "did nothing" |
| `planner rollup [YYYY-MM-DD\|today\|yesterday]` | (M7) rebuild one day's `day_summary` row now (`POST /api/rollup`) and print it: category totals, food, sets/volume, sessions, routine done/total, bed late minutes, final. Default `yesterday`. Use it when the Week view shows a stale day or after a bulk edit |
| `planner export [--out FILE]` | (M7) `GET /api/export` -> a JSON dump of every table (default `~/planner-backups/export-<date>.json`, capped at 20k rows per table; the file lists which tables were truncated). Never prints the data or the token |
| `planner screentime phone --day YYYY-MM-DD --hours '{"7":12,"8":45}' [--dry-run]` | (M7) post a day of iPhone usage read from a Screen Time screenshot: local hours -> UTC `_total` rows, `POST /api/screentime` as the app role (source `phone`, device `iPhone`). `--dry-run` prints the body instead of posting; the recipe below says when to use it |
| `planner config --url URL` | first-time setup |
| `planner food add --json '{...}'` | add a food from a nutrition label: `{name, brand?, serving_g, per_serving:{kcal,protein_g,carb_g,fat_g,fiber_g?,sugar_g?}}` or `per100:{kcal_100,...}`; the Worker converts to per 100 g, stores `source: 'claude'`, prints the row and any 4/4/9 warning |
| `planner food search <q> [--usda] [--branded]` | saved foods matching `q`; `--usda` adds FoodData Central candidates (generic, or `--branded`) |
| `planner eat --food <id\|name> --grams N` / `--meal <id\|name> [--scale S]` `[--at HH:MM] [--slot ...] [--note ...]` | log something eaten with a macro snapshot; an ambiguous name prints the candidates and exits 1 |
| `planner session add --project <name> (--minutes N \| --start HH:MM --end HH:MM) [--note ...] [--day D]` | log a finished study / project session ("log 90 min on planner: built the sync layer") |
| `planner set add (--workout <id> \| --new "Push") --exercise <name> --reps N --weight W [--sets K] [--warmup]` | log sets from text or a gym-notebook photo ("bench 3x8@135") |
| `planner block add --from HH:MM --to HH:MM --category <cat> [--label ...] [--project ...] [--day D]` | fill a gap in the day chart ("1 to 2pm was groceries") |

Every command above is live; `planner <cmd> --help` prints the exact flags.

When the user asks how today is going, run `planner today`. When they ask how yesterday (or any day) went, run
`planner day yesterday` / `planner day YYYY-MM-DD` and answer from its output; never guess. Reading that output:

- `unknown` means no source claimed those minutes (not in bed, no routine tap, no workout/session, nothing
  filled by hand). It is "nothing told the planner", not "wasted"; until the Mac script is installed (README
  section 4) most of a desk day is Unknown. The **Gaps** list is the Unknown runs of 5 min or more; the user fills
  them by tapping the gap in the Day tab or with `planner block add`.
- `mac` rows (VS Code, Terminal, ...) outside any `(session)` block are dev time the user never logged; the app offers
  them as "Log 09:10–10:40 as <project>?" on Today and Work. Point the user at them, or offer `planner session add --start --end`.
- A routine block with `(routine)` and exactly the item's default minutes usually means only the first tap
  happened; the second tap (3+ min later) replaces the default with the real duration.
- `Sleep? (sleep?)` is an open night drawn as an 8 h guess; the user should set the wake time in the app.
- Study/mac sub-rows in the totals are raw seconds from the source tables and can exceed the painted minutes.
- `--json` returns the raw `buildDay` result (`src/shared/day.ts`) when you need the numbers.

When they ask to log something, show what you are about to send and confirm before posting anything that is not
idempotent.

## Recipe: nutrition label -> food (`/label`)

Full version in `.claude/skills/label/SKILL.md`. Summary:

1. Read the label digits exactly as printed (name, brand, serving text, per-serving kcal / protein / carbs / fat,
   fiber and sugars if printed). Never invent or "fix" a digit; ask when unreadable.
2. Serving grams: use the printed gram figure; if only a household measure is printed, ask the user to weigh one
   serving and wait. Do not guess.
3. Per-100 g: multiply by `100 / serving_g`, round to 0.1 (same as `per100FromServing`).
4. 4/4/9 check: `4P + 4C + 9F` vs label kcal; flag (never block) when the gap exceeds max(15 %, 25 kcal).
5. Show the per-serving / per-100 g table plus the 4/4/9 line and ask "Post this?".
6. Only after a yes: `planner food add --json '{...}'` (Worker converts, stores `source='claude'`, returns the
   row and any warning). Then offer `planner eat --food <id> --grams <n>`.

## Recipe: iPhone Screen Time screenshot -> phone hours (`/screentime`)

Full version in `.claude/skills/screentime/SKILL.md`. Summary:

1. Confirm the day and that it is the day view (one bar per hour).
2. Read each hour bar as minutes (0-60) into `{"7":12,"8":45,...}` with local hours as keys. Omit hours you cannot
   read; never guess.
3. Grey/unattributed time is Unknown, never phone use. Never spread the "Most Used" per-app totals across hours.
4. Check the hourly sum is within about 5 minutes of the printed daily total; show the table; ask before posting.
5. Only after a yes: `planner screentime phone --day YYYY-MM-DD --hours '{...}'` (local hours -> UTC `_total`
   rows; the day chart only fills minutes nothing else already claims).

Mac usage never goes through this path: `mac/screentime_push.py` pushes it hourly from launchd.
