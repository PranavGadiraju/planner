-- planner/schema.sql -- Cloudflare D1 (SQLite)
-- Apply locally:  npm run db:local     Apply remotely:  npm run db:remote
-- Conventions
--   * ids are client-generated UUIDs so every write is an idempotent upsert
--   * every *_at / ts column is ISO-8601 UTC text ('2026-09-28T13:05:00.000Z'), sorts lexically
--   * local_day is 'YYYY-MM-DD' in settings.tz, computed with Intl in the Worker or app (never SQLite localtime)
--   * synced tables carry updated_at (client clock, last-writer-wins) and deleted_at (tombstone)
--   * server-only tables (screen_*, day_summary, dirty_days, tap_log, automation_health) may be hard-deleted

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,            -- JSON encoded
  updated_at TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES
  ('tz',             '"America/New_York"',                                   strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('targets',        '{"kcal":2400,"protein_g":170,"carb_g":260,"fat_g":80}', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('bed_target',     '"23:00"',                                              strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('winddown_min',   '45',                                                   strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('late_grace_min', '15',                                                   strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('weight_unit',    '"lb"',                                                 strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ---------------------------------------------------------------- FOOD (everything per 100 g)
CREATE TABLE IF NOT EXISTS foods (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  brand        TEXT,
  source       TEXT NOT NULL CHECK (source IN ('label','off','usda','claude')),
  source_id    TEXT,                    -- barcode (off) | fdcId (usda)
  kcal_100     REAL NOT NULL,
  protein_100  REAL NOT NULL DEFAULT 0,
  carb_100     REAL NOT NULL DEFAULT 0,
  fat_100      REAL NOT NULL DEFAULT 0,
  fiber_100    REAL,
  sugar_100    REAL,
  serving_g    REAL,
  serving_text TEXT,
  label_json   TEXT,                    -- raw label numbers as typed / read (audit)
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_foods_source ON foods(source, source_id);

CREATE TABLE IF NOT EXISTS meals (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  total_g      REAL NOT NULL DEFAULT 0,
  kcal         REAL NOT NULL DEFAULT 0, -- totals at scale 1.0 (denormalised for one-tap logging)
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
  deleted_at   TEXT
);

CREATE TABLE IF NOT EXISTS meal_items (
  id         TEXT PRIMARY KEY,
  meal_id    TEXT NOT NULL REFERENCES meals(id),
  food_id    TEXT NOT NULL REFERENCES foods(id),
  grams      REAL NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_meal_items_meal ON meal_items(meal_id);

CREATE TABLE IF NOT EXISTS food_log (
  id         TEXT PRIMARY KEY,
  ts         TEXT NOT NULL,
  local_day  TEXT NOT NULL,
  slot       TEXT NOT NULL CHECK (slot IN ('breakfast','lunch','dinner','snack')),
  food_id    TEXT REFERENCES foods(id),
  meal_id    TEXT REFERENCES meals(id),
  grams      REAL,                      -- when food_id
  scale      REAL,                      -- when meal_id (1.0 = whole meal)
  label      TEXT NOT NULL,             -- display-name snapshot
  kcal       REAL NOT NULL,             -- SNAPSHOT: later food edits never rewrite history
  protein_g  REAL NOT NULL DEFAULT 0,
  carb_g     REAL NOT NULL DEFAULT 0,
  fat_g      REAL NOT NULL DEFAULT 0,
  fiber_g    REAL,
  sugar_g    REAL,
  note       TEXT,
  source     TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','cli')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (food_id IS NOT NULL OR meal_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS ix_food_log_day ON food_log(local_day);

-- ---------------------------------------------------------------- LIFTING
CREATE TABLE IF NOT EXISTS exercises (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  muscle       TEXT,
  load_type    TEXT NOT NULL DEFAULT 'weight' CHECK (load_type IN ('weight','bodyweight')),
  weight_step  REAL NOT NULL DEFAULT 5,
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

CREATE TABLE IF NOT EXISTS workouts (
  id         TEXT PRIMARY KEY,
  name       TEXT,                      -- template name: Push | Pull | Legs ...
  started_at TEXT NOT NULL,
  ended_at   TEXT,                      -- NULL = in progress
  local_day  TEXT NOT NULL,
  note       TEXT,
  ended_by   TEXT CHECK (ended_by IN ('user','auto')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_workouts_day ON workouts(local_day);

CREATE TABLE IF NOT EXISTS sets (
  id          TEXT PRIMARY KEY,
  workout_id  TEXT NOT NULL REFERENCES workouts(id),
  exercise_id TEXT NOT NULL REFERENCES exercises(id),
  set_no      INTEGER NOT NULL,
  reps        INTEGER NOT NULL,
  weight      REAL NOT NULL DEFAULT 0,  -- in settings.weight_unit; 0 for bodyweight
  is_warmup   INTEGER NOT NULL DEFAULT 0,
  ts          TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS ix_sets_workout     ON sets(workout_id, exercise_id, set_no);
CREATE INDEX IF NOT EXISTS ix_sets_exercise_ts ON sets(exercise_id, ts);

-- ---------------------------------------------------------------- PROJECTS / STUDY
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'project' CHECK (kind IN ('project','study')),
  color       TEXT,
  position    INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  started_at TEXT NOT NULL,
  ended_at   TEXT,                      -- NULL = running
  local_day  TEXT NOT NULL,             -- day of started_at
  duration_s INTEGER,
  note       TEXT,                      -- what got done
  source     TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','cli','suggest')),
  ended_by   TEXT CHECK (ended_by IN ('user','auto')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_sessions_day     ON sessions(local_day);
CREATE INDEX IF NOT EXISTS ix_sessions_project ON sessions(project_id, started_at);

CREATE TABLE IF NOT EXISTS checkins (
  local_day    TEXT PRIMARY KEY,
  morning_at   TEXT,
  morning_note TEXT,
  evening_at   TEXT,
  evening_note TEXT,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);

-- ---------------------------------------------------------------- MORNING ROUTINE (NFC)
CREATE TABLE IF NOT EXISTS routine_items (
  id             TEXT PRIMARY KEY,      -- slug the Shortcut sends
  name           TEXT NOT NULL,
  icon           TEXT,
  position       INTEGER NOT NULL DEFAULT 0,
  default_min    INTEGER NOT NULL DEFAULT 10,   -- used when only one tap happened
  chart_category TEXT NOT NULL DEFAULT 'routine' CHECK (chart_category IN ('routine','workout')),
  active         INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT
);
INSERT OR IGNORE INTO routine_items(id, name, icon, position, default_min, chart_category, active, updated_at) VALUES
  ('shower',    'Shower',           'shower',    1, 15, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('run',       'Morning run',      'run',       2, 40, 'workout', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('stretch',   'Morning stretch',  'stretch',   3, 10, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('shoulders', 'Shoulder routine', 'shoulders', 4, 10, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('journal',   'Morning journal',  'journal',   5, 10, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- First tap of the day starts the item, a second tap >= 3 min later ends it. PK makes double taps idempotent.
CREATE TABLE IF NOT EXISTS routine_log (
  local_day  TEXT NOT NULL,
  item_id    TEXT NOT NULL REFERENCES routine_items(id),
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  source     TEXT NOT NULL CHECK (source IN ('nfc','app','cli')),
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (local_day, item_id)
);

-- ---------------------------------------------------------------- SLEEP
CREATE TABLE IF NOT EXISTS sleep (
  night_of    TEXT PRIMARY KEY,         -- local date of (bed_ts - 12 h)
  bed_ts      TEXT NOT NULL,
  wake_ts     TEXT,
  bed_source  TEXT NOT NULL CHECK (bed_source IN ('nfc','app','cli')),
  wake_source TEXT CHECK (wake_source IN ('routine','nfc','app','cli')),
  target_bed  TEXT NOT NULL,            -- 'HH:MM' snapshot of settings.bed_target that night
  late_min    INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  deleted_at  TEXT
);

-- ---------------------------------------------------------------- MANUAL TIME BLOCKS (gap filling; always win on the chart)
CREATE TABLE IF NOT EXISTS time_blocks (
  id         TEXT PRIMARY KEY,
  start_ts   TEXT NOT NULL,
  end_ts     TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('sleep','workout','study','routine','meal','chores','social','commute','rest','phone','other')),
  label      TEXT,
  project_id TEXT REFERENCES projects(id),
  source     TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','cli')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  CHECK (end_ts > start_ts)
);
CREATE INDEX IF NOT EXISTS ix_time_blocks_start ON time_blocks(start_ts);

-- ---------------------------------------------------------------- SCREEN TIME (server-only; Mac script + CLI)
CREATE TABLE IF NOT EXISTS screen_hours (
  source     TEXT NOT NULL CHECK (source IN ('mac','phone')),
  device     TEXT NOT NULL,
  hour_start TEXT NOT NULL,             -- UTC hour start '2026-09-28T13:00:00.000Z'
  app_id     TEXT NOT NULL,             -- bundle id, or '_total' for phone hours
  seconds    INTEGER NOT NULL CHECK (seconds BETWEEN 0 AND 3600),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, device, hour_start, app_id)
);
CREATE INDEX IF NOT EXISTS ix_screen_hours_hour ON screen_hours(hour_start);

CREATE TABLE IF NOT EXISTS screen_intervals (
  source     TEXT NOT NULL CHECK (source IN ('mac','phone')),
  device     TEXT NOT NULL,
  start_ts   TEXT NOT NULL,
  end_ts     TEXT NOT NULL,
  top_app    TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (source, device, start_ts),
  CHECK (end_ts > start_ts)
);
CREATE INDEX IF NOT EXISTS ix_screen_intervals_end ON screen_intervals(end_ts);

CREATE TABLE IF NOT EXISTS app_categories (
  app_id       TEXT PRIMARY KEY,        -- bundle id
  label        TEXT,
  category     TEXT CHECK (category IN ('dev','work','comms','browsing','media','social','other')), -- NULL = needs triage
  seen_seconds INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL,
  deleted_at   TEXT
);
INSERT OR IGNORE INTO app_categories(app_id, label, category, updated_at) VALUES
  ('com.microsoft.VSCode',              'Visual Studio Code', 'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.todesktop.230313mzl4w4u92',     'Cursor',             'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.dt.Xcode',                'Xcode',              'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.Terminal',                'Terminal',           'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.googlecode.iterm2',             'iTerm',              'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('dev.warp.Warp-Stable',              'Warp',               'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.mitchellh.ghostty',             'Ghostty',            'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.anthropic.claudefordesktop',    'Claude',             'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.google.android.studio',         'Android Studio',     'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.jetbrains.intellij',            'IntelliJ IDEA',      'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.jetbrains.pycharm',             'PyCharm',            'dev',      strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.Safari',                  'Safari',             'browsing', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.google.Chrome',                 'Chrome',             'browsing', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('company.thebrowser.Browser',        'Arc',                'browsing', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('org.mozilla.firefox',               'Firefox',            'browsing', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.tinyspeck.slackmacgap',         'Slack',              'comms',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.hnc.Discord',                   'Discord',            'comms',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.MobileSMS',               'Messages',           'comms',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.mail',                    'Mail',               'comms',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('us.zoom.xos',                       'Zoom',               'comms',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.FaceTime',                'FaceTime',           'comms',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.Notes',                   'Notes',              'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('md.obsidian',                       'Obsidian',           'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('notion.id',                         'Notion',             'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.iCal',                    'Calendar',           'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.reminders',               'Reminders',          'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.Preview',                 'Preview',            'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.iWork.Pages',             'Pages',              'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.iWork.Numbers',           'Numbers',            'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.iWork.Keynote',           'Keynote',            'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.microsoft.Word',                'Word',               'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.microsoft.Excel',               'Excel',              'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.microsoft.Powerpoint',          'PowerPoint',         'work',     strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.Music',                   'Music',              'media',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.TV',                      'TV',                 'media',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.spotify.client',                'Spotify',            'media',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.valvesoftware.steam',           'Steam',              'media',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.Photos',                  'Photos',             'media',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.finder',                  'Finder',             'other',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.systempreferences',       'System Settings',    'other',    strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ('com.apple.ActivityMonitor',         'Activity Monitor',   'other',    strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- ---------------------------------------------------------------- ROLLUPS + OPS (server-only)
CREATE TABLE IF NOT EXISTS day_summary (
  local_day          TEXT PRIMARY KEY,
  sleep_s            INTEGER NOT NULL DEFAULT 0,
  workout_s          INTEGER NOT NULL DEFAULT 0,
  study_s            INTEGER NOT NULL DEFAULT 0,
  routine_s          INTEGER NOT NULL DEFAULT 0,
  mac_s              INTEGER NOT NULL DEFAULT 0,
  phone_s            INTEGER NOT NULL DEFAULT 0,
  manual_s           INTEGER NOT NULL DEFAULT 0,
  unknown_s          INTEGER NOT NULL DEFAULT 0,
  tracked_s          INTEGER NOT NULL DEFAULT 0,
  mac_by_category    TEXT NOT NULL DEFAULT '{}',
  study_by_project   TEXT NOT NULL DEFAULT '{}',
  manual_by_category TEXT NOT NULL DEFAULT '{}',
  kcal               REAL,
  protein_g          REAL,
  carb_g             REAL,
  fat_g              REAL,
  sets_count         INTEGER NOT NULL DEFAULT 0,
  volume             REAL NOT NULL DEFAULT 0,
  sessions_count     INTEGER NOT NULL DEFAULT 0,
  routine_done       INTEGER NOT NULL DEFAULT 0,
  routine_total      INTEGER NOT NULL DEFAULT 0,
  bed_late_min       INTEGER,
  final              INTEGER NOT NULL DEFAULT 0,
  computed_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dirty_days (
  local_day TEXT PRIMARY KEY,
  marked_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tap_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  item   TEXT NOT NULL,
  role   TEXT NOT NULL,
  result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS automation_health (
  source        TEXT PRIMARY KEY,       -- mac | nfc | cli | cron
  last_ok_at    TEXT,
  last_error_at TEXT,
  last_error    TEXT,
  detail        TEXT
);
