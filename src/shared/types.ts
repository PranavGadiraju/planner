// Shared row and payload types. Every *_at / ts is an ISO-8601 UTC string; local_day is YYYY-MM-DD in settings.tz.
export type ISO = string
export type LocalDay = string
export type Role = 'app' | 'shortcut' | 'mac'
export type Source = 'nfc' | 'app' | 'cli'

export interface Settings {
  tz: string
  targets: { kcal: number; protein_g: number; carb_g: number; fat_g: number }
  bed_target: string // 'HH:MM' local
  winddown_min: number
  late_grace_min: number
  weight_unit: 'kg' | 'lb'
}
export const DEFAULT_SETTINGS: Settings = {
  tz: 'America/New_York',
  targets: { kcal: 2400, protein_g: 170, carb_g: 260, fat_g: 80 },
  bed_target: '23:00',
  winddown_min: 45,
  late_grace_min: 15,
  weight_unit: 'lb',
}

export interface RoutineItem {
  id: string
  name: string
  icon: string | null
  position: number
  default_min: number
  chart_category: 'routine' | 'workout'
  active: number
  updated_at: ISO
  deleted_at: ISO | null
}
export interface RoutineLog {
  local_day: LocalDay
  item_id: string
  started_at: ISO
  ended_at: ISO | null
  source: Source
  updated_at: ISO
  deleted_at: ISO | null
}
export interface Sleep {
  night_of: LocalDay
  bed_ts: ISO
  wake_ts: ISO | null
  bed_source: Source
  wake_source: 'routine' | Source | null
  target_bed: string
  late_min: number
  updated_at: ISO
  deleted_at: ISO | null
}
export type BlockCategory =
  | 'sleep' | 'workout' | 'study' | 'routine' | 'meal' | 'chores' | 'social' | 'commute' | 'rest' | 'phone' | 'other'
export interface TimeBlock {
  id: string
  start_ts: ISO
  end_ts: ISO
  category: BlockCategory
  label: string | null
  project_id: string | null
  source: 'app' | 'cli'
  created_at: ISO
  updated_at: ISO
  deleted_at: ISO | null
}
export interface Checkin {
  local_day: LocalDay
  morning_at: ISO | null
  morning_note: string | null
  evening_at: ISO | null
  evening_note: string | null
  updated_at: ISO
  deleted_at: ISO | null
}
export interface Food {
  id: string; name: string; brand: string | null
  source: 'label' | 'off' | 'usda' | 'claude'; source_id: string | null
  kcal_100: number; protein_100: number; carb_100: number; fat_100: number
  fiber_100: number | null; sugar_100: number | null
  serving_g: number | null; serving_text: string | null; label_json: string | null
  use_count: number; last_used_at: ISO | null
  created_at: ISO; updated_at: ISO; deleted_at: ISO | null
}
export interface Meal {
  id: string; name: string; total_g: number
  kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null; sugar_g: number | null
  default_slot: Slot | null; use_count: number; last_used_at: ISO | null
  created_at: ISO; updated_at: ISO; deleted_at: ISO | null
}
export interface MealItem { id: string; meal_id: string; food_id: string; grams: number; position: number; updated_at: ISO; deleted_at: ISO | null }
export type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack'
export interface FoodLog {
  id: string; ts: ISO; local_day: LocalDay; slot: Slot
  food_id: string | null; meal_id: string | null; grams: number | null; scale: number | null
  label: string; kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null; sugar_g: number | null
  note: string | null; source: 'app' | 'cli'; created_at: ISO; updated_at: ISO; deleted_at: ISO | null
}
export interface Exercise {
  id: string; name: string; muscle: string | null; load_type: 'weight' | 'bodyweight'; weight_step: number
  use_count: number; last_used_at: ISO | null; created_at: ISO; updated_at: ISO; deleted_at: ISO | null
}
export interface Workout {
  id: string; name: string | null; started_at: ISO; ended_at: ISO | null; local_day: LocalDay; note: string | null
  ended_by: 'user' | 'auto' | null; created_at: ISO; updated_at: ISO; deleted_at: ISO | null
}
export interface SetRow {
  id: string; workout_id: string; exercise_id: string; set_no: number; reps: number; weight: number; is_warmup: number
  ts: ISO; updated_at: ISO; deleted_at: ISO | null
}
export interface Project {
  id: string; name: string; kind: 'project' | 'study'; color: string | null; position: number; archived_at: ISO | null
  created_at: ISO; updated_at: ISO; deleted_at: ISO | null
}
export interface Session {
  id: string; project_id: string; started_at: ISO; ended_at: ISO | null; local_day: LocalDay; duration_s: number | null
  note: string | null; source: 'app' | 'cli' | 'suggest'; ended_by: 'user' | 'auto' | null
  created_at: ISO; updated_at: ISO; deleted_at: ISO | null
}
export type AppCategory = 'dev' | 'work' | 'comms' | 'browsing' | 'media' | 'social' | 'other'
export interface AppCategoryRow { app_id: string; label: string | null; category: AppCategory | null; seen_seconds: number; updated_at: ISO; deleted_at: ISO | null }

// ---- /api/tap
export type TapAction =
  | 'routine_started' | 'routine_finished' | 'routine_duplicate' | 'routine_ignored' | 'routine_already_done'
  | 'bed' | 'bed_duplicate' | 'bed_ignored' | 'bed_daytime_ignored' | 'wake' | 'wake_duplicate' | 'nap_then_bed'
  | 'winddown' | 'unknown_item'
export interface TapResponse {
  ok: boolean
  action: TapAction
  item: string
  local_day: LocalDay
  message: string
}

// ---- /api/write
export interface WriteMutation { table: string; rows: Record<string, unknown>[] }
export interface WriteRequest { mutations: WriteMutation[] }
export interface WriteResponse { applied: number; rejected: { table: string; key: string; reason: string }[] }

// ---- /api/today
export interface HealthRow { source: string; last_ok_at: ISO | null; last_error_at: ISO | null; last_error: string | null; detail: string | null }
export interface TodayPayload {
  today: LocalDay
  now: ISO
  tz: string
  settings: Settings
  routine_items: RoutineItem[]
  routine_log: RoutineLog[]
  sleep: { tonight: Sleep | null; last_night: Sleep | null; streak: number; open: Sleep | null }
  checkin: Checkin | null
  running: { workout: Workout | null; session: (Session & { project_name: string }) | null }
  health: { rows: HealthRow[]; taps_today: number; mac_last_hour: ISO | null; phone_last_hour: ISO | null; apps_to_triage: number }
}

// ---- /api/day/:date
/** How fresh the automatic sources are (the foot of the Day/Week/Month views): same MAX() facts as /api/today's health. */
export interface DayFreshness { mac_last_hour: ISO | null; phone_last_hour: ISO | null; mac_last_ok_at: ISO | null }

// ---- day_summary rows (rollups)
export interface DaySummary {
  local_day: string
  sleep_s: number
  workout_s: number
  study_s: number
  routine_s: number
  mac_s: number
  phone_s: number
  manual_s: number
  unknown_s: number
  tracked_s: number
  mac_by_category: Record<string, number>
  study_by_project: Record<string, number>
  manual_by_category: Record<string, number>
  kcal: number | null
  protein_g: number | null
  carb_g: number | null
  fat_g: number | null
  sets_count: number
  volume: number
  sessions_count: number
  routine_done: number
  routine_total: number
  bed_late_min: number | null
  final: number
  /** null only for the placeholder of a day that has no row yet (stale, never computed). */
  computed_at: string | null
  /** Today: computed on request, never stored. */
  live?: true
  /** A past day whose row is missing or still waiting for a rebuild (the view offers a refresh). */
  stale?: true
}
