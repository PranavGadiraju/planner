// The day_summary row: its shape, its SQL, and the pure math that composes one from a buildDay result plus a few
// SQL sums. No D1 or Worker globals (vitest imports it); src/worker/rollup.ts does the reading and writing.
import type { DayResult } from '../../../shared/day'
import { addDays, localDay } from '../../../shared/tz'
import { rowLocalDay } from '../../db'

/** One day_summary row as the API returns it (JSON columns parsed, numbers coerced). Mirrored in src/app/data/summary.ts. */
import type { DaySummary } from '../../../shared/types'
export type { DaySummary }

/** The raw D1 row (JSON maps are TEXT). */
export interface DaySummaryRow extends Omit<DaySummary, 'mac_by_category' | 'study_by_project' | 'manual_by_category'> {
  mac_by_category: string
  study_by_project: string
  manual_by_category: string
}

export const SUMMARY_COLUMNS = [
  'local_day', 'sleep_s', 'workout_s', 'study_s', 'routine_s', 'mac_s', 'phone_s', 'manual_s', 'unknown_s', 'tracked_s',
  'mac_by_category', 'study_by_project', 'manual_by_category', 'kcal', 'protein_g', 'carb_g', 'fat_g',
  'sets_count', 'volume', 'sessions_count', 'routine_done', 'routine_total', 'bed_late_min', 'final', 'computed_at',
] as const

export const SUMMARY_UPSERT_SQL =
  `INSERT INTO day_summary (${SUMMARY_COLUMNS.join(', ')}) VALUES (${SUMMARY_COLUMNS.map(() => '?').join(', ')}) ` +
  `ON CONFLICT(local_day) DO UPDATE SET ${SUMMARY_COLUMNS.filter((c) => c !== 'local_day').map((c) => `${c} = excluded.${c}`).join(', ')}`

export const SUMMARY_SELECT_SQL = `SELECT ${SUMMARY_COLUMNS.join(', ')} FROM day_summary WHERE local_day >= ? AND local_day <= ? ORDER BY local_day`

/** SQL sums that buildDay does not produce, bound to one local day (they ride in the loadDayInput batch). */
export const AGGREGATE_SQL = [
  'SELECT COUNT(*) AS n, SUM(kcal) AS kcal, SUM(protein_g) AS protein_g, SUM(carb_g) AS carb_g, SUM(fat_g) AS fat_g FROM food_log WHERE local_day = ? AND deleted_at IS NULL',
  'SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN s.is_warmup = 0 THEN s.reps * s.weight ELSE 0 END), 0) AS volume ' +
    'FROM sets s JOIN workouts w ON w.id = s.workout_id WHERE w.local_day = ? AND s.deleted_at IS NULL AND w.deleted_at IS NULL',
  'SELECT COUNT(*) AS n FROM sessions WHERE local_day = ? AND deleted_at IS NULL',
] as const

export interface SummaryAggregates {
  food: { n: number; kcal: number | null; protein_g: number | null; carb_g: number | null; fat_g: number | null }
  sets: { n: number; volume: number }
  sessions: { n: number }
}

/** The part of a D1Result this module reads (structural, so no Worker types are needed here). */
export interface ResultLike { results?: unknown[] }

const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : d
}
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v))

function firstRow(r: ResultLike | undefined): Record<string, unknown> {
  return ((r?.results ?? [])[0] ?? {}) as Record<string, unknown>
}

/** The aggregate results (in AGGREGATE_SQL order) -> typed sums; a missing row means zero / null. */
export function parseAggregates(results: readonly (ResultLike | undefined)[]): SummaryAggregates {
  const food = firstRow(results[0])
  const sets = firstRow(results[1])
  const sessions = firstRow(results[2])
  const foodN = num(food['n'])
  return {
    food: {
      n: foodN,
      kcal: foodN ? numOrNull(food['kcal']) : null,
      protein_g: foodN ? numOrNull(food['protein_g']) : null,
      carb_g: foodN ? numOrNull(food['carb_g']) : null,
      fat_g: foodN ? numOrNull(food['fat_g']) : null,
    },
    sets: { n: num(sets['n']), volume: num(sets['volume']) },
    sessions: { n: num(sessions['n']) },
  }
}

export interface SummaryFacts {
  routine_done: number
  routine_total: number
  bed_late_min: number | null
  /** The server's local today; a day two or more days back is final. */
  today: string
  nowIso: string
}

/** True when a day's inputs can no longer change through normal use (two full days have passed). */
export function isFinalDay(day: string, today: string): boolean {
  return day <= addDays(today, -2)
}

/** Pure: a buildDay result + the SQL sums + a few counted facts -> the day_summary row. */
export function composeSummary(day: string, r: DayResult, agg: SummaryAggregates, f: SummaryFacts): DaySummary {
  const t = r.totals
  return {
    local_day: day,
    sleep_s: t.sleep_s, workout_s: t.workout_s, study_s: t.study_s, routine_s: t.routine_s,
    mac_s: t.mac_s, phone_s: t.phone_s, manual_s: t.manual_s, unknown_s: t.unknown_s, tracked_s: t.tracked_s,
    mac_by_category: { ...r.mac_by_category },
    study_by_project: { ...r.study_by_project },
    manual_by_category: { ...r.manual_by_category },
    kcal: agg.food.kcal, protein_g: agg.food.protein_g, carb_g: agg.food.carb_g, fat_g: agg.food.fat_g,
    sets_count: agg.sets.n, volume: agg.sets.volume, sessions_count: agg.sessions.n,
    routine_done: f.routine_done, routine_total: f.routine_total,
    bed_late_min: f.bed_late_min,
    final: isFinalDay(day, f.today) ? 1 : 0,
    computed_at: f.nowIso,
  }
}

function parseMap(text: unknown): Record<string, number> {
  if (typeof text !== 'string' || !text) return {}
  try {
    const v = JSON.parse(text) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
    const out: Record<string, number> = {}
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = num(x)
    return out
  } catch {
    return {}
  }
}

/** A raw day_summary row -> the API shape (JSON maps parsed, every number a number). */
export function rowToSummary(row: DaySummaryRow | Record<string, unknown>): DaySummary {
  const r = row as Record<string, unknown>
  return {
    local_day: String(r['local_day'] ?? ''),
    sleep_s: num(r['sleep_s']), workout_s: num(r['workout_s']), study_s: num(r['study_s']), routine_s: num(r['routine_s']),
    mac_s: num(r['mac_s']), phone_s: num(r['phone_s']), manual_s: num(r['manual_s']), unknown_s: num(r['unknown_s']), tracked_s: num(r['tracked_s']),
    mac_by_category: parseMap(r['mac_by_category']),
    study_by_project: parseMap(r['study_by_project']),
    manual_by_category: parseMap(r['manual_by_category']),
    kcal: numOrNull(r['kcal']), protein_g: numOrNull(r['protein_g']), carb_g: numOrNull(r['carb_g']), fat_g: numOrNull(r['fat_g']),
    sets_count: num(r['sets_count']), volume: num(r['volume']), sessions_count: num(r['sessions_count']),
    routine_done: num(r['routine_done']), routine_total: num(r['routine_total']),
    bed_late_min: numOrNull(r['bed_late_min']),
    final: num(r['final']) ? 1 : 0,
    computed_at: typeof r['computed_at'] === 'string' ? r['computed_at'] : null,
  }
}

/** The bind parameters for SUMMARY_UPSERT_SQL, in SUMMARY_COLUMNS order. */
export function summaryParams(s: DaySummary): (string | number | null)[] {
  return SUMMARY_COLUMNS.map((c) => {
    const v = s[c]
    if (c === 'mac_by_category' || c === 'study_by_project' || c === 'manual_by_category') return JSON.stringify(v ?? {})
    if (c === 'computed_at') return s.computed_at ?? new Date(0).toISOString()
    return typeof v === 'number' || typeof v === 'string' ? v : null
  })
}

/** A zeroed row for a day that has no summary yet (returned as `stale` until something computes it). */
export function emptySummary(day: string): DaySummary {
  return {
    local_day: day,
    sleep_s: 0, workout_s: 0, study_s: 0, routine_s: 0, mac_s: 0, phone_s: 0, manual_s: 0, unknown_s: 0, tracked_s: 0,
    mac_by_category: {}, study_by_project: {}, manual_by_category: {},
    kcal: null, protein_g: null, carb_g: null, fat_g: null,
    sets_count: 0, volume: 0, sessions_count: 0, routine_done: 0, routine_total: 0, bed_late_min: null,
    final: 0, computed_at: null,
  }
}

/**
 * Every local day a written row can change on the chart: its own day (db.ts rowLocalDay) plus the day its end
 * falls on (a night's wake morning, a block or session past midnight), so both summaries get marked and rebuilt.
 */
export function rowDays(table: string, row: Record<string, unknown>, tz: string): string[] {
  const days = new Set<string>()
  const own = rowLocalDay(table, row, tz)
  if (own) days.add(own)
  const ts = (k: string) => (typeof row[k] === 'string' && row[k] && !Number.isNaN(new Date(row[k] as string).getTime()) ? localDay(row[k] as string, tz) : null)
  if (table === 'sleep' && own) days.add(addDays(own, 1))
  const end = table === 'time_blocks' ? ts('end_ts') : table === 'workouts' || table === 'sessions' ? ts('ended_at') : null
  if (end) days.add(end)
  return [...days]
}
