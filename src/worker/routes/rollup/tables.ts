// What GET /api/export dumps: every table in schema.sql, capped per table. Pure so the list can be unit-tested.

export const EXPORT_ROW_CAP = 20_000

/** Every table in schema.sql, in schema order. */
export const EXPORT_TABLES = [
  'settings', 'foods', 'meals', 'meal_items', 'food_log', 'exercises', 'workouts', 'sets', 'projects', 'sessions', 'checkins',
  'routine_items', 'routine_log', 'sleep', 'time_blocks', 'screen_hours', 'screen_intervals', 'app_categories',
  'day_summary', 'dirty_days', 'tap_log', 'automation_health',
] as const
