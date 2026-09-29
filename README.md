# planner

A free, personal daily-life planner you own: one installable web app (iPhone + Mac) that tracks meals and calories,
workouts set by set, study and side-project sessions, a morning routine checked off by tapping NFC stickers,
bedtime, and a 24-hour "where did the day go" chart that fills itself in from Mac screen time and your logs.

It is a Preact + Vite PWA served by **one Cloudflare Worker on the free plan**, with a JSON API under `/api/*`
backed by **D1 (SQLite)** and one Cron Trigger. No credit card, nothing pauses. Three bearer tokens keep it private:
`APP_TOKEN` (the app and the CLI), `SHORTCUT_TOKEN` (the NFC Shortcut, may only call `POST /api/tap`) and
`MAC_TOKEN` (the Mac screen-time script, may only call `POST /api/screentime`).

The full design (schema, API, algorithms, screens, milestones) is in [`docs/plan.md`](docs/plan.md).
Milestone 1 ships: Worker auth + `/api/health`, `/api/me`, `/api/tap`, `/api/write`, `/api/today`, the tap log,
automation health, the PWA shell with Today and Settings, the `planner` CLI, and the Mac automation files.

---

## 1. One-time setup (about 20 minutes)

You need: Node 20+ (`node -v`), a Cloudflare account, an iPhone XS or newer, and this repo cloned to
`~/Desktop/planner` (any folder works; the Mac LaunchAgents are written with whatever path you install from).

```sh
cd ~/Desktop/planner
npm install

# 1. log in to Cloudflare (opens the browser once)
npx wrangler login

# 2. create the database and paste its id into wrangler.jsonc
npx wrangler d1 create planner
#    -> copy the "database_id" it prints into wrangler.jsonc, replacing REPLACE_WITH_ID_FROM_wrangler_d1_create

# 3. apply the schema (tables + seeds: settings, routine items, app categories)
npm run db:remote

# 4. secrets: generate one value per token, paste it when wrangler prompts (never pass it on the command line)
openssl rand -base64 32      # run this once per token and keep the values in your password manager
npx wrangler secret put APP_TOKEN
npx wrangler secret put SHORTCUT_TOKEN
npx wrangler secret put MAC_TOKEN
npx wrangler secret put USDA_KEY   # free key from https://fdc.nal.usda.gov/api-key-signup (used from milestone 3; any placeholder works until then)

# 5. build and deploy
npm run deploy
#    -> prints https://planner.<your-subdomain>.workers.dev ; check https://planner.<your-subdomain>.workers.dev/api/health
```

### Install the app

- **iPhone:** open the URL in Safari, Share > **Add to Home Screen**. Open it from the Home Screen (that is the
  installed, full-screen version), go to Settings, paste `APP_TOKEN`, tap **Test**.
- **Mac:** open the URL in Safari, **File > Add to Dock**. Paste the same `APP_TOKEN` in Settings.

The token stays on the device (localStorage, mirrored in IndexedDB). Rotate any token with
`npx wrangler secret put <NAME>` and re-paste it where it is used; the others keep working.

### CLI on the Mac

```sh
mkdir -p ~/bin && ln -sfn "$PWD/bin/planner" ~/bin/planner     # make sure ~/bin is on your PATH
planner config --url https://planner.<your-subdomain>.workers.dev
security add-generic-password -U -a "$USER" -s planner-app-token -w    # prompts; paste APP_TOKEN
planner me
planner today
```

`planner --help` lists everything; see [section 5](#5-cli-binplanner).

---

## 2. Local development

```sh
npm run db:local                    # applies schema.sql to the local D1 in .wrangler/state
cat > .dev.vars <<'EOF'             # local secrets for wrangler dev (git-ignored); use any strings you like
APP_TOKEN=dev-app
SHORTCUT_TOKEN=dev-shortcut
MAC_TOKEN=dev-mac
USDA_KEY=DEMO_KEY
EOF
npm run build                       # once, so ./dist exists for the assets binding
npm run dev:worker                  # wrangler dev -> http://localhost:8787 (API + built assets)
npm run dev                         # vite -> http://localhost:5173 with /api proxied to :8787 (hot reload)
```

Checks: `npm run typecheck` (app and worker tsconfigs), `npm test` (vitest). Try the API:

```sh
curl -s localhost:8787/api/health
curl -s -X POST localhost:8787/api/tap -H 'Authorization: Bearer dev-shortcut' -H 'content-type: application/json' -d '{"item":"shower"}'
PLANNER_URL=http://localhost:8787 PLANNER_TOKEN=dev-app node bin/planner today
```

---

## 3. NFC stickers and the iOS Shortcut

### Buy stickers

A 10-pack of plain **NXP NTAG213** (or NTAG215) **25 mm PET stickers**, about $5-10. Do **not** write anything to
them: the Shortcuts NFC trigger keys on the tag's hardware UID and ignores the contents. Use the ferrite "on-metal"
variety only where a sticker goes on metal (a shower rail, a barbell rack). You need six: shower, run, stretch,
shoulders, journal, and one for the nightstand (bed).

### The one Shortcut: "Planner Tap"

Create it once; every sticker automation calls it with a different input, so the token lives in exactly one place.

1. Shortcuts app > **+** > name it **Planner Tap**.
2. Add **Get Contents of URL**. URL: `https://planner.<your-subdomain>.workers.dev/api/tap`. Tap the chevron
   (**Show More**): Method **POST**; Headers **+** `Authorization` = `Bearer <SHORTCUT_TOKEN>`; Request Body
   **JSON** > Add new field > **Text**, key `item`, value: tap the field and pick the **Shortcut Input** variable.
3. Add **Get Dictionary Value**: key `ok` from **Contents of URL**.
4. Add **If**: *Dictionary Value* **is not** *true* (booleans show as a toggle; make sure it reads "is not true").
   Inside the If: **Show Notification** with title `Planner failed` and body `Shortcut Input`. This is the only
   way a broken token, a typo in a slug, or a Worker error is visible: Get Contents of URL does not fail on a
   4xx/401 body, it just returns it, and then `ok` is missing or false.
5. Optional, in the **Otherwise** branch: **Get Dictionary Value** key `message` from Contents of URL, then
   **Show Notification** with that value ("Shower started 07:42", "Run done · 41 min", "In bed 23:20 (+20 min) · streak 4").
6. Run it once manually (play button, type `shower` when asked for input). When iOS asks to allow the shortcut to
   send data to your Worker, choose **Always Allow**. Check the tap landed: `planner taps` or Settings > tap log.

### Six NFC automations

For each of `shower`, `run`, `stretch`, `shoulders`, `journal`, `bed`:

1. Shortcuts > **Automation** tab > **+** > **NFC** > **Scan**: hold the top edge of the iPhone against the sticker
   until it is recognised; name it after the slug; **Next**.
2. Choose **Run Immediately** (this is "Ask Before Running" off; tap **Don't Ask** if a confirmation appears) and
   turn **Notify When Run** **on** for the first week so you see the small banner each time it fires. **Next**.
3. Action: **Run Shortcut** > **Planner Tap** > tap **Show More** / the input field and set **Input** to the text
   slug (`shower`, `run`, ..., `bed`). **Done**.

Slugs must match `routine_items.id` (the seeded five above) or the special items `bed`, `wake`, `winddown`.
Editing routine items in Settings shows the exact slug to use; the Settings **Shortcut setup** page repeats this
recipe with your URL filled in.

**The gesture:** raise the phone (Face ID unlocks it), touch the top edge to the sticker for about a second.
Nothing opens; the POST goes out in the background. The screen must be on and the phone must have been unlocked
once since boot; tag reading pauses while Camera, Wallet/Apple Pay, another NFC session or Airplane Mode is active.
Whether a locked-but-awake phone runs the network action is disputed, so test it once; plan on "raise, then tap".

**After every iOS update, open each automation and re-check that it still says Run Immediately** (updates have
flipped automations back to "Ask"). Personal automations do not sync via iCloud: recreate all six on a new iPhone.

### Wind-down reminder (Time of Day automation)

1. Shortcuts > **Automation** > **+** > **Time of Day** > set `bed_target - winddown_min` (with the defaults
   23:00 and 45 that is **22:15**) > **Daily** > **Next**.
2. **Run Immediately**, then add **Show Notification**: "Wind down, bed by 23:00".
3. Optional second action: **Run Shortcut** > **Planner Tap** with input `winddown`. The server writes nothing for
   this item; the Shortcut's success notification then shows the streak line ("Wind down · streak 4 · last night +20").
4. This time is set by hand: when you change the bed target or wind-down minutes in Settings, the app reminds you
   to edit this automation.

Tap the nightstand sticker (`bed`) when you turn the light off. The next morning, the **first routine-sticker tap
of the day is your wake signal** (you had to get out of bed to reach it); the sleep row closes with
`wake_source = 'routine'`. Re-tapping the nightstand sticker after at least 3 hours also works as a wake tap.

---

## 4. Mac screen time (automatic, hourly)

`mac/screentime_push.py` (standard-library Python, run with `/usr/bin/python3`) copies macOS's Screen Time
knowledge store (`~/Library/Application Support/Knowledge/knowledgeC.db`), reads the app-usage intervals of this
Mac for the last few hours, splits them into per-app seconds per UTC hour plus merged "focus" intervals, and POSTs
them to `/api/screentime` with `MAC_TOKEN`. It aborts without posting when the window is empty, only advances its
watermark (`~/.config/planner/last_run`) after a 2xx, and re-sends a 3 h overlap each run so late-written rows
are picked up (the Worker replaces the window, so re-sends never duplicate).

> `/api/screentime` lands in milestone 6. Until then the agent logs `-> 404` every hour and keeps its watermark;
> that is expected. Install it now anyway so Full Disk Access is settled.

### Install

```sh
sh mac/install.sh --url https://planner.<your-subdomain>.workers.dev
```

This symlinks the script to `~/bin/screentime_push.py`, writes the two LaunchAgents into `~/Library/LaunchAgents`
with your home folder, repo path and URL filled in, and prints the next steps, which are:

**a. Full Disk Access for `/usr/bin/python3`** (TCC keys the grant to the exact executable launchd runs).
System Settings > Privacy & Security > **Full Disk Access**. In Finder press **Cmd+Shift+G**, type `/usr/bin`, and
**drag `python3` from that Finder window into the Full Disk Access list**. The **+** picker did not show bare
executables on macOS 26.1-26.2; dragging applies the grant even when no row appears. Verify from a normal shell:

```sh
/usr/bin/python3 -c "import sqlite3,os;c=sqlite3.connect('file:'+os.path.expanduser('~/Library/Application Support/Knowledge/knowledgeC.db')+'?mode=ro',uri=True);print(c.execute(\"select count(*) from ZOBJECT where ZSTREAMNAME='/app/usage'\").fetchone())"
```

A row count means it works; `authorization denied` / `Operation not permitted` means the grant did not apply.
To see the grant itself (auth_value 2 = allowed):

```sh
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" "select client,auth_value from access where service='kTCCServiceSystemPolicyAllFiles'"
```

The macOS Screen Time store (RMAdminStore) is never touched; it is EPERM on macOS 26.3+ even with FDA.

**b. MAC_TOKEN in the login Keychain** (prompted, so it never enters shell history; never put it in the plist,
plists are world-readable):

```sh
security add-generic-password -U -a "$USER" -s planner-mac-token -w
```

The script reads it with `security find-generic-password -s planner-mac-token -w`; if a Keychain dialog appears
on the first launchd run, choose **Always Allow**. Fallback: a `chmod 600` file at `~/.config/planner/mac_token`.

**c. Test, then load:**

```sh
PLANNER_URL=https://planner.<your-subdomain>.workers.dev /usr/bin/python3 ~/bin/screentime_push.py --dry-run
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pranav.planner-screentime.plist
launchctl kickstart -k gui/$(id -u)/com.pranav.planner-screentime      # run now instead of waiting for :05
tail -n 30 ~/Library/Logs/planner-screentime.log ~/Library/Logs/planner-screentime.err
```

The agent runs every hour at :05 and at login (`RunAtLoad`). Reload after editing the plist with
`launchctl bootout gui/$(id -u)/com.pranav.planner-screentime` and bootstrap again. `sh mac/install.sh --load`
does the bootstrap/kickstart for you.

### Flags and knobs

| | |
|---|---|
| `--dry-run` | print the summary (stream used, rows, hours, intervals, top apps) and post nothing |
| `--since 2026-09-27T00:00:00Z` | backfill from a time (capped at 48 h to protect the D1 write budget) |
| `--print-payload` | dump the JSON body |
| `PLANNER_KNOWLEDGEC_PATH` | read a different database (tests use a fake one with the real table names) |
| `PLANNER_CONFIG_DIR` | where the watermark, the mdfind app-name cache (`app_names.json`) and the token fallback live (default `~/.config/planner`) |

What it reads: `/app/inFocus` (frontmost app) first; if that stream has fewer than 25 % of the rows `/app/usage`
would give, it falls back to `/app/usage` and says so in the log. Only rows with `ZSOURCE.ZDEVICEID IS NULL`
(this Mac). Window `[max(watermark - 3 h, now - 26 h), now)`. `com.apple.loginwindow`, screen-saver bundles and
`com.apple.dock` are ignored. Intervals are unioned with a 120 s gap tolerance, unions under 60 s dropped, each
tagged with its top app. New bundle ids are named with `mdfind` and cached. Roughly 35 rows an hour.

iPhone usage has no automatic source; until the optional Biome decoder stretch (milestone 8) you paste a Screen
Time screenshot into Claude Code (`/screentime`).

---

## 5. CLI: `bin/planner`

Zero-dependency Node (>= 20) script. URL from `~/.config/planner/config.json` (`{"url": "..."}`) or `PLANNER_URL`;
token from `PLANNER_TOKEN` or the Keychain item `planner-app-token`. It never prints the token.

| Command | |
|---|---|
| `planner me` | validate URL + token; tz, server time, today |
| `planner health` | `/api/health` liveness plus the automation_health rows |
| `planner today [--json]` | routine state, sleep card + streak, running workout/session, check-ins, automation health |
| `planner tap <item> [--at ISO]` | log a tap as the app role (same state machine as the stickers) |
| `planner taps [--json]` | last 100 tap_log rows, newest first |
| `planner config [--url URL]` | show / set the Worker URL |

Later milestones (stubs that print "not available until milestone N" and exit 2 today): `food add --json`,
`food search`, `eat`, `day`, `block add` (M3); `session add`, `set add` (M5); `rollup`, `export` (M7);
`screentime phone` (M8). `CLAUDE.md` explains how Claude Code uses the CLI and the `/label` and `/screentime`
recipes.

Exit codes: 0 ok, 1 error (cannot reach the Worker, 401/403, server error), 2 usage / not yet available.

---

## 6. Backups

- **Weekly dump on the Mac:** `mac/install.sh` installs `com.pranav.planner-backup` (Sundays 09:30, and once at
  load), which runs `mac/backup.sh` from the repo directory:
  `npx wrangler d1 export planner --remote --output ~/planner-backups/<date>.sql` and keeps the newest 12.
  Load it with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.pranav.planner-backup.plist`;
  run by hand with `sh mac/backup.sh`; logs in `~/Library/Logs/planner-backup.log`.
- **Restore** into a fresh database: `npx wrangler d1 execute planner --remote --file ~/planner-backups/<date>.sql`.
- **D1 Time Travel** keeps 7 days of point-in-time restore: `npx wrangler d1 time-travel restore planner --timestamp <ISO>`.
- **JSON export** (`GET /api/export`, `planner export`) arrives with milestone 7.
- The repo itself (code, schema) lives on GitHub as a private repo.

---

## 7. Troubleshooting

| Symptom | What it means / what to do |
|---|---|
| `planner: cannot reach ...: ECONNREFUSED` or `ENOTFOUND` | wrong URL or the Worker is not deployed; `planner config` shows the URL, `curl <url>/api/health` should answer |
| `401` from the app, CLI or Shortcut | the token does not match the Worker secret; re-paste it (Settings, Keychain `planner-app-token`, or the Shortcut header). Secrets set with `wrangler secret put` take effect on the next request |
| `403` | right token, wrong route: the Shortcut token may only call `/api/tap`, the Mac token only `/api/screentime` |
| `404` from the Mac script | `/api/screentime` is not deployed yet (milestone 6) or the URL in the plist is wrong (`PLANNER_URL` should be the site root, without `/api/...`) |
| "Planner failed: shower" notification on the phone | the Worker rejected the tap: check `planner taps` (a 400 leaves a tap_log row with the reason), the slug spelling, and the token in the Shortcut |
| A sticker tap does nothing at all | Notify When Run on? Screen on and phone unlocked once since boot? Camera/Wallet closed? Open the automation: after an iOS update it may say "Ask Before Running" again |
| Second tap says "Already done" / "duplicate" | taps < 2 min apart are duplicates, 2-3 min are ignored, >= 3 min finish the item; edit or undo from Today |
| `Operation not permitted` / `authorization denied` reading knowledgeC.db | Full Disk Access is not applied to `/usr/bin/python3`; drag it into the FDA list again and run the verification one-liner; Terminal needs FDA too for manual tests (relaunch it after granting) |
| Keychain prompt every hour | choose **Always Allow** once, or create the item again with `security add-generic-password -U ...` from Terminal |
| `launchctl bootstrap` says `Input/output error` (5) or `already loaded` (37) | the agent is already loaded; `launchctl bootout gui/$(id -u)/<label>` first, then bootstrap again |
| `launchctl kickstart` runs but the log is empty | look at the `.err` file next to it; `plutil -lint` the plist; the script path in `ProgramArguments` must exist (`ls -l ~/bin/screentime_push.py`) |
| `npm run dev:worker` complains about `./dist` | run `npm run build` once so the assets directory exists |
| Wrong "today" around midnight | the server computes local day in `TZ` from `wrangler.jsonc` (`America/New_York`) with Intl; change `vars.TZ` and the `tz` setting together |
| App shows stale UI after a deploy | the PWA shows a "Reload for update" toast; or force-close and reopen the Home Screen app |
| `wrangler` says the database id is a placeholder | paste the id from `npx wrangler d1 create planner` into `wrangler.jsonc` |

---

## 8. API summary (milestone 1)

| Method + path | Role | Purpose |
|---|---|---|
| `GET /api/health` | none | `{ok, version, time, today}` |
| `GET /api/me` | app | `{role, tz, server_time, today}` |
| `POST /api/tap` `{item, ts?}` | shortcut, app | routine start/finish, `bed`, `wake`, `winddown`; server-timestamped for the shortcut role; every call logged to `tap_log` |
| `POST /api/write` `{mutations:[{table, rows}]}` | app | batched idempotent upserts (max 200 rows) guarded by `updated_at`; past days marked dirty |
| `GET /api/today` | app | routine items + today's log, sleep (tonight, last night, open, streak), check-in, running timers, health |
| `GET /api/tap/log` | app | last 100 taps |
| `GET /api/health/automations` | app | automation_health rows |
| `GET /api/settings` | app | parsed settings (write them through `/api/write`, table `settings`) |

Everything else in `docs/plan.md` (day chart, food, lifting, sessions, lookups, screentime, summaries, export,
cron rollups) arrives in milestones 2-8 and returns 404 until then. The cron trigger currently only prunes
`tap_log` to 500 rows.
