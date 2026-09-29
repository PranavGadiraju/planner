// Pure helpers behind the lift routes: history aggregation, range cut-offs and the POST /api/sets body parser.
// No D1 or Worker globals here so vitest can exercise them (test/worker-lift.test.ts).
import { HttpError, isRecord } from '../../http'
import { epley1RM } from '../../../shared/nutrition'
import type { Exercise, SetRow, Workout } from '../../../shared/types'

export type HistoryRange = '1m' | '3m' | '1y' | 'all'
export const HISTORY_RANGES: readonly HistoryRange[] = ['1m', '3m', '1y', 'all']

/** A workout row plus the SQL aggregates GET /api/workouts adds (non-warm-up, non-deleted sets only). */
export interface WorkoutSummary extends Workout { sets_count: number; volume: number; exercises_count: number }
/** A set plus the best e1RM of the same exercise before it (any workout), so the client can flag PRs. */
export interface SetWithPrior extends SetRow { prior_best: number | null }
export interface WorkoutDetail { workout: Workout; sets: SetWithPrior[]; exercises: Exercise[] }
export interface TemplatePayload { workout: Workout | null; sets: SetRow[]; exercises: Exercise[] }
export interface LastSet extends SetRow { local_day: string; workout_name: string | null }
/** The best e1RM logged in one workout. */
export interface WorkoutBest { workout_id: string; best: number }
/**
 * best_e1rm is the best ever; bests holds the top two workouts by best so the app can take "the best outside the
 * running workout" from one payload (bests[0], or bests[1] when bests[0] is that workout) and keep a single, complete
 * cache entry per exercise for the gym.
 */
export interface LastSetsPayload { sets: LastSet[]; best_e1rm: number | null; bests: WorkoutBest[] }

/** One row of the history query: a set joined to its workout, ordered by (started_at, ts, set_no). */
export interface HistoryRow {
  workout_id: string
  local_day: string
  started_at: string
  name: string | null
  id: string
  set_no: number
  reps: number
  weight: number
  is_warmup: number
  ts: string
}
export interface HistorySet { id: string; set_no: number; reps: number; weight: number; is_warmup: number; ts: string }
export interface HistorySession {
  workout_id: string
  local_day: string
  started_at: string
  name: string | null
  sets: HistorySet[]
  /** Best Epley e1RM among the non-warm-up sets, null when the session only had warm-ups. */
  best_e1rm: number | null
  /** Sum of reps x weight over non-warm-up sets. */
  volume: number
  total_reps: number
  /** The set behind best_e1rm. */
  top_set: { reps: number; weight: number } | null
  /** True when best_e1rm beats every earlier session (and the best before the range, when one was given). */
  is_pr: boolean
}
export interface HistoryPayload { exercise: Exercise; range: HistoryRange; sessions: HistorySession[] }

const r1 = (n: number) => Math.round(n * 10) / 10

export function parseRange(raw: string | null): HistoryRange {
  const v = (raw ?? 'all').trim().toLowerCase()
  if ((HISTORY_RANGES as readonly string[]).includes(v)) return v as HistoryRange
  throw new HttpError(400, 'range must be 1m, 3m, 1y or all')
}

const RANGE_DAYS: Record<Exclude<HistoryRange, 'all'>, number> = { '1m': 30, '3m': 91, '1y': 365 }

/** ISO instant a range starts at (null for 'all'). */
export function rangeStart(range: HistoryRange, now: Date): string | null {
  if (range === 'all') return null
  return new Date(now.getTime() - RANGE_DAYS[range] * 86400_000).toISOString()
}

/**
 * Group history rows (ordered by workout start, then ts, set_no) into sessions with e1RM / volume / PR flags.
 * `priorBest` is the best e1RM before the first row (from before the range), so a range never invents a PR.
 */
export function buildHistory(rows: readonly HistoryRow[], priorBest: number | null = null): HistorySession[] {
  const sessions: HistorySession[] = []
  let cur: HistorySession | null = null
  for (const r of rows) {
    if (!cur || cur.workout_id !== r.workout_id) {
      cur = { workout_id: r.workout_id, local_day: r.local_day, started_at: r.started_at, name: r.name, sets: [], best_e1rm: null, volume: 0, total_reps: 0, top_set: null, is_pr: false }
      sessions.push(cur)
    }
    cur.sets.push({ id: r.id, set_no: r.set_no, reps: r.reps, weight: r.weight, is_warmup: r.is_warmup, ts: r.ts })
    if (r.is_warmup) continue
    cur.volume = r1(cur.volume + r.reps * r.weight)
    cur.total_reps += r.reps
    const e = epley1RM(r.weight, r.reps)
    if (cur.best_e1rm === null || e > cur.best_e1rm) {
      cur.best_e1rm = e
      cur.top_set = { reps: r.reps, weight: r.weight }
    }
  }
  let best = priorBest
  for (const s of sessions) {
    if (s.best_e1rm !== null && (best === null || s.best_e1rm > best)) {
      s.is_pr = true
      best = s.best_e1rm
    }
  }
  return sessions
}

// ---- POST /api/sets body

export interface SetInput { reps: number; weight: number; is_warmup: number }
export interface SetsBody {
  /** Append to this workout (must exist)... */
  workoutId: string | null
  /** ...or create one: name, whether it stays open, and optional start / end instants for a back-dated log. */
  newWorkout: { name: string | null; open: boolean; started_at: string | null; ended_at: string | null } | null
  /** Exercise id, or a name matched case-insensitively (created when unknown). */
  exercise: string
  sets: SetInput[]
}

const MAX_SETS = 100

function toInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null
}
function toNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parseSet(v: unknown, i: number): SetInput {
  if (!isRecord(v)) throw new HttpError(400, `sets[${i}] must be an object`)
  const reps = toInt(v['reps'])
  if (reps === null || reps < 1 || reps > 1000) throw new HttpError(400, `sets[${i}].reps must be an integer between 1 and 1000`)
  const weight = v['weight'] === undefined ? 0 : toNum(v['weight'])
  if (weight === null || weight < 0) throw new HttpError(400, `sets[${i}].weight must be a number >= 0`)
  const warm = v['is_warmup']
  if (warm !== undefined && typeof warm !== 'boolean' && warm !== 0 && warm !== 1) throw new HttpError(400, `sets[${i}].is_warmup must be a boolean`)
  return { reps, weight, is_warmup: warm === true || warm === 1 ? 1 : 0 }
}

/** {workout_id | new_workout: {name, open?, started_at?, ended_at?}, exercise, sets: [...] | reps + weight [+ count]} -> SetsBody, or HttpError(400). */
export function parseSetsBody(body: unknown): SetsBody {
  if (!isRecord(body)) throw new HttpError(400, 'body must be a JSON object')
  const exercise = typeof body['exercise'] === 'string' ? body['exercise'].trim() : ''
  if (!exercise) throw new HttpError(400, 'exercise (name or id) required')

  const wid = body['workout_id']
  const nw = body['new_workout']
  if (wid !== undefined && nw !== undefined) throw new HttpError(400, 'give workout_id or new_workout, not both')
  let workoutId: string | null = null
  let newWorkout: SetsBody['newWorkout'] = null
  if (wid !== undefined) {
    if (typeof wid !== 'string' || !wid.trim()) throw new HttpError(400, 'workout_id must be a non-empty string')
    workoutId = wid.trim()
  } else if (nw !== undefined) {
    if (!isRecord(nw)) throw new HttpError(400, 'new_workout must be an object')
    const name = nw['name'] === undefined || nw['name'] === null ? null : typeof nw['name'] === 'string' ? nw['name'].trim() || null : undefined
    if (name === undefined) throw new HttpError(400, 'new_workout.name must be a string')
    if (nw['open'] !== undefined && typeof nw['open'] !== 'boolean') throw new HttpError(400, 'new_workout.open must be a boolean')
    const iso = (k: 'started_at' | 'ended_at'): string | null => {
      if (nw[k] === undefined || nw[k] === null) return null
      const t = typeof nw[k] === 'string' ? new Date(nw[k] as string) : new Date(NaN)
      if (Number.isNaN(t.getTime())) throw new HttpError(400, `new_workout.${k} must be an ISO timestamp`)
      return t.toISOString()
    }
    const started = iso('started_at')
    const ended = iso('ended_at')
    if (ended && started && ended < started) throw new HttpError(400, 'new_workout.ended_at must not be before started_at')
    if (ended && nw['open'] === true) throw new HttpError(400, 'new_workout.ended_at and open=true cannot be combined')
    newWorkout = { name, open: nw['open'] === true, started_at: started, ended_at: ended }
  } else {
    throw new HttpError(400, 'workout_id or new_workout required')
  }

  let sets: SetInput[]
  if (body['sets'] !== undefined) {
    if (!Array.isArray(body['sets']) || body['sets'].length === 0) throw new HttpError(400, 'sets must be a non-empty array')
    if (body['sets'].length > MAX_SETS) throw new HttpError(400, `at most ${MAX_SETS} sets per request`)
    sets = (body['sets'] as unknown[]).map(parseSet)
  } else {
    if (body['reps'] === undefined) throw new HttpError(400, 'sets[] or reps + weight required')
    const count = body['count'] === undefined ? 1 : toInt(body['count'])
    if (count === null || count < 1 || count > MAX_SETS) throw new HttpError(400, `count must be an integer between 1 and ${MAX_SETS}`)
    const one = parseSet({ reps: body['reps'], weight: body['weight'], is_warmup: body['is_warmup'] }, 0)
    sets = Array.from({ length: count }, () => ({ ...one }))
  }
  return { workoutId, newWorkout, exercise, sets }
}

/** Parse ?limit= with a default and a cap. */
export function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be a positive integer')
  return Math.min(n, max)
}

/** Parse ?before= as an ISO instant (null when absent). */
export function parseBefore(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null
  const t = new Date(raw)
  if (Number.isNaN(t.getTime())) throw new HttpError(400, 'before must be an ISO timestamp')
  return t.toISOString()
}
