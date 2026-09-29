// Table registry (column allowlists from schema.sql), the idempotent upsert builder, local-day extraction for
// dirty_days, and the settings parser. Pure: no D1 globals, so vitest can exercise it outside the Worker.
import type { Settings } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { localDay } from '../shared/tz'

export type Scalar = string | number | null

export interface TableSpec {
  pk: readonly string[]
  columns: readonly string[]
  /** How a row is placed on a local day (for dirty_days): a YYYY-MM-DD column, or an ISO timestamp column. */
  day?: { column: string; kind: 'day' | 'ts' }
}

const SYNC = ['created_at', 'updated_at', 'deleted_at'] as const

/** Every table /api/write may touch, with its primary key and the exact columns schema.sql defines. */
export const TABLES: Readonly<Record<string, TableSpec>> = {
  settings: { pk: ['key'], columns: ['key', 'value', 'updated_at'] },
  foods: {
    pk: ['id'],
    columns: ['id', 'name', 'brand', 'source', 'source_id', 'kcal_100', 'protein_100', 'carb_100', 'fat_100', 'fiber_100', 'sugar_100',
      'serving_g', 'serving_text', 'label_json', 'use_count', 'last_used_at', ...SYNC],
  },
  meals: {
    pk: ['id'],
    columns: ['id', 'name', 'total_g', 'kcal', 'protein_g', 'carb_g', 'fat_g', 'fiber_g', 'sugar_g', 'default_slot', 'use_count', 'last_used_at', ...SYNC],
  },
  meal_items: { pk: ['id'], columns: ['id', 'meal_id', 'food_id', 'grams', 'position', 'updated_at', 'deleted_at'] },
  food_log: {
    pk: ['id'],
    columns: ['id', 'ts', 'local_day', 'slot', 'food_id', 'meal_id', 'grams', 'scale', 'label', 'kcal', 'protein_g', 'carb_g', 'fat_g',
      'fiber_g', 'sugar_g', 'note', 'source', ...SYNC],
    day: { column: 'local_day', kind: 'day' },
  },
  exercises: { pk: ['id'], columns: ['id', 'name', 'muscle', 'load_type', 'weight_step', 'use_count', 'last_used_at', ...SYNC] },
  workouts: {
    pk: ['id'],
    columns: ['id', 'name', 'started_at', 'ended_at', 'local_day', 'note', 'ended_by', ...SYNC],
    day: { column: 'local_day', kind: 'day' },
  },
  sets: {
    pk: ['id'],
    columns: ['id', 'workout_id', 'exercise_id', 'set_no', 'reps', 'weight', 'is_warmup', 'ts', 'updated_at', 'deleted_at'],
    day: { column: 'ts', kind: 'ts' },
  },
  projects: { pk: ['id'], columns: ['id', 'name', 'kind', 'color', 'position', 'archived_at', ...SYNC] },
  sessions: {
    pk: ['id'],
    columns: ['id', 'project_id', 'started_at', 'ended_at', 'local_day', 'duration_s', 'note', 'source', 'ended_by', ...SYNC],
    day: { column: 'local_day', kind: 'day' },
  },
  checkins: {
    pk: ['local_day'],
    columns: ['local_day', 'morning_at', 'morning_note', 'evening_at', 'evening_note', 'updated_at', 'deleted_at'],
    day: { column: 'local_day', kind: 'day' },
  },
  routine_items: {
    pk: ['id'],
    columns: ['id', 'name', 'icon', 'position', 'default_min', 'chart_category', 'active', 'updated_at', 'deleted_at'],
  },
  routine_log: {
    pk: ['local_day', 'item_id'],
    columns: ['local_day', 'item_id', 'started_at', 'ended_at', 'source', 'updated_at', 'deleted_at'],
    day: { column: 'local_day', kind: 'day' },
  },
  sleep: {
    pk: ['night_of'],
    columns: ['night_of', 'bed_ts', 'wake_ts', 'bed_source', 'wake_source', 'target_bed', 'late_min', 'updated_at', 'deleted_at'],
    day: { column: 'bed_ts', kind: 'ts' },
  },
  time_blocks: {
    pk: ['id'],
    columns: ['id', 'start_ts', 'end_ts', 'category', 'label', 'project_id', 'source', ...SYNC],
    day: { column: 'start_ts', kind: 'ts' },
  },
  app_categories: { pk: ['app_id'], columns: ['app_id', 'label', 'category', 'seen_seconds', 'updated_at', 'deleted_at'] },
}

export const TABLE_NAMES: readonly string[] = Object.keys(TABLES)

/**
 * INSERT ... ON CONFLICT(pk) DO UPDATE SET col = excluded.col ... [WHERE excluded.updated_at > table.updated_at].
 * The guard (default on) makes a stale replay a no-op; server-authoritative writes pass guard = false.
 */
export function buildUpsertSql(table: string, columns: readonly string[], guard = true): string {
  const spec = TABLES[table]
  if (!spec) throw new Error(`unknown table ${table}`)
  const setCols = columns.filter((c) => !spec.pk.includes(c))
  const placeholders = columns.map(() => '?').join(', ')
  const head = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT(${spec.pk.join(', ')})`
  if (setCols.length === 0) return `${head} DO NOTHING`
  const set = setCols.map((c) => `${c} = excluded.${c}`).join(', ')
  return guard ? `${head} DO UPDATE SET ${set} WHERE excluded.updated_at > ${table}.updated_at` : `${head} DO UPDATE SET ${set}`
}

export type RowCheck =
  | { ok: true; key: string; columns: string[]; params: Scalar[] }
  | { ok: false; key: string; reason: string }

function scalar(v: unknown): Scalar | undefined {
  if (v === null) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'boolean') return v ? 1 : 0
  return undefined
}

/** Validate a row against the registry: known table, primary key + updated_at present, only allowed columns, scalar values. */
export function validateRow(table: string, input: object): RowCheck {
  const row = input as Record<string, unknown> // typed row interfaces (Sleep, RoutineLog...) have no index signature
  const spec = TABLES[table]
  const key = spec ? spec.pk.map((c) => String(row[c] ?? '')).join('|') : '?'
  if (!spec) return { ok: false, key, reason: `unknown table ${table}` }
  for (const c of spec.pk) {
    const v = row[c]
    if (v === undefined || v === null || v === '') return { ok: false, key, reason: `missing primary key ${c}` }
  }
  if (typeof row['updated_at'] !== 'string' || !row['updated_at']) return { ok: false, key, reason: 'missing updated_at' }
  const columns: string[] = []
  const params: Scalar[] = []
  for (const [col, raw] of Object.entries(row)) {
    if (raw === undefined) continue
    if (!spec.columns.includes(col)) return { ok: false, key, reason: `unknown column ${col}` }
    const v = scalar(raw)
    if (v === undefined) return { ok: false, key, reason: `column ${col} must be a string, number, boolean or null` }
    columns.push(col)
    params.push(v)
  }
  return { ok: true, key, columns, params }
}

/** The local day a row belongs to (for dirty_days), or null when the table is not day-scoped or the value is unusable. */
export function rowLocalDay(table: string, row: object, tz: string): string | null {
  const day = TABLES[table]?.day
  if (!day) return null
  const v = (row as Record<string, unknown>)[day.column]
  if (typeof v !== 'string' || !v) return null
  if (day.kind === 'day') return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
  const t = new Date(v)
  return Number.isNaN(t.getTime()) ? null : localDay(t, tz)
}

/** Build a ready-to-bind upsert for a row the server itself produced (throws on a registry violation = programming error). */
export function upsertFor(table: string, row: object, guard = true): { sql: string; params: Scalar[] } {
  const check = validateRow(table, row)
  if (!check.ok) throw new Error(`${table}: ${check.reason}`)
  return { sql: buildUpsertSql(table, check.columns, guard), params: check.params }
}

// ---- settings

export const SETTINGS_SQL = 'SELECT key, value FROM settings'
export interface SettingsRow { key: string; value: string }

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** settings rows (JSON-encoded values) -> Settings with defaults filled and malformed values replaced by defaults. */
export function parseSettings(rows: readonly SettingsRow[]): Settings {
  const raw: Record<string, unknown> = {}
  for (const r of rows) {
    try {
      raw[r.key] = JSON.parse(r.value)
    } catch {
      /* malformed value: keep the default */
    }
  }
  const d = DEFAULT_SETTINGS
  const targetsIn = raw['targets']
  const targets = { ...d.targets }
  if (typeof targetsIn === 'object' && targetsIn !== null) {
    for (const k of ['kcal', 'protein_g', 'carb_g', 'fat_g'] as const) {
      const v = (targetsIn as Record<string, unknown>)[k]
      if (isNum(v)) targets[k] = v
    }
  }
  const tz = raw['tz']
  const bed = raw['bed_target']
  const wind = raw['winddown_min']
  const grace = raw['late_grace_min']
  const unit = raw['weight_unit']
  return {
    tz: typeof tz === 'string' && tz ? tz : d.tz,
    targets,
    bed_target: typeof bed === 'string' && /^\d{2}:\d{2}$/.test(bed) ? bed : d.bed_target,
    winddown_min: isNum(wind) && wind >= 0 ? wind : d.winddown_min,
    late_grace_min: isNum(grace) && grace >= 0 ? grace : d.late_grace_min,
    weight_unit: unit === 'kg' || unit === 'lb' ? unit : d.weight_unit,
  }
}

/** Structural subset of D1Database used here, so this module stays importable outside the Worker tsconfig. */
export interface SettingsDb {
  prepare(sql: string): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> }
}

export async function loadSettings(db: SettingsDb): Promise<Settings> {
  const { results } = await db.prepare(SETTINGS_SQL).all<SettingsRow>()
  return parseSettings(results)
}
