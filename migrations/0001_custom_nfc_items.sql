-- Replace the original demo routine with Pranav's first NFC MVP while preserving historical rows.
INSERT INTO projects(id, name, kind, color, position, archived_at, created_at, updated_at, deleted_at)
VALUES (
  'personal-work', 'Personal work', 'project', '#a855f7', 1, NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL
)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  kind = excluded.kind,
  color = excluded.color,
  archived_at = NULL,
  updated_at = excluded.updated_at,
  deleted_at = NULL;

UPDATE routine_items
SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id IN ('shower', 'run', 'stretch', 'journal');

INSERT INTO routine_items(id, name, icon, position, default_min, chart_category, active, updated_at, deleted_at) VALUES
  ('morning-workout', 'Morning workout',   'lift',      1, 45, 'workout', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('morning-stretch', 'Morning stretch',   'stretch',   2, 10, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('shoulders',       'Shoulder exercise', 'shoulders', 3, 10, 'workout', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('workday',         'Away at work',       'work',      4, 480, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('evening-workout', 'Evening workout',   'lift',      5, 45, 'workout', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('treadmill',       'Walking treadmill', 'run',       6, 30, 'workout', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('personal-work',   'Personal work',      'work',      7, 50, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL),
  ('vitamins',        'Vitamins',           'check',     8,  1, 'routine', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'), NULL)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  icon = excluded.icon,
  position = excluded.position,
  default_min = excluded.default_min,
  chart_category = excluded.chart_category,
  active = 1,
  updated_at = excluded.updated_at,
  deleted_at = NULL;
