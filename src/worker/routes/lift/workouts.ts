// GET /api/workouts, GET /api/workouts/:id, GET /api/lift/template, GET /api/lift/last-sets (app role).
import type { RouteContext } from '../../env'
import { HttpError, json } from '../../http'
import type { Exercise, SetRow, Workout } from '../../../shared/types'
import { parseBefore, parseLimit } from './logic'
import type { LastSet, LastSetsPayload, SetWithPrior, TemplatePayload, WorkoutBest, WorkoutDetail, WorkoutSummary } from './logic'
import { E1RM_SQL } from './exercises'

const e1rm = (alias: string) => E1RM_SQL.replaceAll('{s}', alias)
const r1 = (n: number) => Math.round(n * 10) / 10

function rows<T>(r: D1Result<unknown> | undefined): T[] {
  return (r?.results ?? []) as T[]
}

// Aggregates over non-warm-up, non-deleted sets, in SQL (a LEFT JOIN so an empty workout still lists).
const LIST_SQL =
  'SELECT w.*, COUNT(s.id) AS sets_count, COALESCE(SUM(s.reps * s.weight), 0) AS volume, COUNT(DISTINCT s.exercise_id) AS exercises_count ' +
  'FROM workouts w LEFT JOIN sets s ON s.workout_id = w.id AND s.deleted_at IS NULL AND s.is_warmup = 0 ' +
  'WHERE w.deleted_at IS NULL AND (? IS NULL OR w.started_at < ?) ' +
  'GROUP BY w.id ORDER BY w.started_at DESC LIMIT ?'

/** Newest first; ?limit= (default 50, max 200) and ?before=<ISO> (started_at strictly before) for paging. */
export async function listWorkouts(c: RouteContext): Promise<Response> {
  const limit = parseLimit(c.url.searchParams.get('limit'), 50, 200)
  const before = parseBefore(c.url.searchParams.get('before'))
  const { results } = await c.env.DB.prepare(LIST_SQL).bind(before, before, limit).all<WorkoutSummary>()
  return json({ workouts: results })
}

// Each set carries the best e1RM of its exercise before it (any workout), so the client flags PRs without more calls.
const DETAIL_SETS_SQL =
  `SELECT s.*, (SELECT MAX(${e1rm('p')}) FROM sets p JOIN workouts pw ON pw.id = p.workout_id ` +
  'WHERE p.exercise_id = s.exercise_id AND (p.ts < s.ts OR (p.ts = s.ts AND p.set_no < s.set_no)) AND p.is_warmup = 0 AND p.deleted_at IS NULL AND pw.deleted_at IS NULL) AS prior_best ' +
  'FROM sets s WHERE s.workout_id = ? AND s.deleted_at IS NULL ORDER BY s.ts, s.set_no'
const REFERENCED_EXERCISES_SQL =
  'SELECT * FROM exercises WHERE id IN (SELECT DISTINCT exercise_id FROM sets WHERE workout_id = ? AND deleted_at IS NULL) ORDER BY name COLLATE NOCASE'

export async function workoutDetail(c: RouteContext): Promise<Response> {
  const id = c.params['id'] ?? ''
  const db = c.env.DB
  const [wR, sR, eR] = await db.batch([
    db.prepare('SELECT * FROM workouts WHERE id = ? AND deleted_at IS NULL LIMIT 1').bind(id),
    db.prepare(DETAIL_SETS_SQL).bind(id),
    db.prepare(REFERENCED_EXERCISES_SQL).bind(id),
  ])
  const workout = rows<Workout>(wR)[0]
  if (!workout) throw new HttpError(404, 'workout not found')
  const sets = rows<SetWithPrior>(sR).map((s) => ({ ...s, prior_best: typeof s.prior_best === 'number' ? r1(s.prior_best) : null }))
  const payload: WorkoutDetail = { workout, sets, exercises: rows<Exercise>(eR) }
  return json(payload)
}

// The most recent finished workout with that name that logged at least one set (an empty one is no template).
const TEMPLATE_WORKOUT_SQL =
  'SELECT w.id FROM workouts w WHERE lower(trim(w.name)) = ? AND w.ended_at IS NOT NULL AND w.deleted_at IS NULL ' +
  'AND EXISTS (SELECT 1 FROM sets s WHERE s.workout_id = w.id AND s.deleted_at IS NULL) ORDER BY w.started_at DESC LIMIT 1'

/** GET /api/lift/template?name=Push -> the last finished "Push" with its sets and exercises, or workout: null. */
export async function template(c: RouteContext): Promise<Response> {
  const name = (c.url.searchParams.get('name') ?? '').trim().toLowerCase()
  if (!name) throw new HttpError(400, 'name required')
  const db = c.env.DB
  const [wR, sR, eR] = await db.batch([
    db.prepare(`SELECT * FROM workouts WHERE id = (${TEMPLATE_WORKOUT_SQL})`).bind(name),
    db.prepare(`SELECT * FROM sets WHERE workout_id = (${TEMPLATE_WORKOUT_SQL}) AND deleted_at IS NULL ORDER BY ts, set_no`).bind(name),
    db.prepare(
      `SELECT * FROM exercises WHERE id IN (SELECT DISTINCT exercise_id FROM sets WHERE workout_id = (${TEMPLATE_WORKOUT_SQL}) AND deleted_at IS NULL) ORDER BY name COLLATE NOCASE`,
    ).bind(name),
  ])
  const payload: TemplatePayload = { workout: rows<Workout>(wR)[0] ?? null, sets: rows<SetRow>(sR), exercises: rows<Exercise>(eR) }
  return json(payload)
}

const LAST_SETS_SQL =
  'SELECT s.*, w.local_day, w.name AS workout_name FROM sets s JOIN workouts w ON w.id = s.workout_id ' +
  'WHERE s.exercise_id = ? AND s.is_warmup = 0 AND s.deleted_at IS NULL AND w.deleted_at IS NULL AND (? IS NULL OR s.workout_id != ?) ' +
  'ORDER BY s.ts DESC, s.set_no DESC LIMIT 30' // enough that the current workout's own sets never hide the last session
// Best e1RM per workout, top two: bests[0] is the best ever; the best outside any one workout is bests[0] or bests[1].
const BESTS_SQL =
  `SELECT s.workout_id, MAX(${e1rm('s')}) AS best FROM sets s JOIN workouts w ON w.id = s.workout_id ` +
  'WHERE s.exercise_id = ? AND s.is_warmup = 0 AND s.deleted_at IS NULL AND w.deleted_at IS NULL AND (? IS NULL OR s.workout_id != ?) ' +
  'GROUP BY s.workout_id ORDER BY best DESC, MAX(s.ts) DESC LIMIT 2'

/**
 * GET /api/lift/last-sets?exercise_id=X[&exclude=<workout_id>] -> the last 10 working sets (newest first), the best
 * e1RM ever and the top two workouts by best. The app no longer sends exclude (it keeps one complete cache entry per
 * exercise and excludes the running workout from bests itself); the parameter stays for the CLI and older clients.
 */
export async function lastSets(c: RouteContext): Promise<Response> {
  const exerciseId = (c.url.searchParams.get('exercise_id') ?? '').trim()
  if (!exerciseId) throw new HttpError(400, 'exercise_id required')
  const exclude = (c.url.searchParams.get('exclude') ?? '').trim() || null
  const db = c.env.DB
  const [sR, bR] = await db.batch([
    db.prepare(LAST_SETS_SQL).bind(exerciseId, exclude, exclude),
    db.prepare(BESTS_SQL).bind(exerciseId, exclude, exclude),
  ])
  const bests: WorkoutBest[] = rows<{ workout_id: string; best: number | null }>(bR)
    .filter((b): b is { workout_id: string; best: number } => typeof b.best === 'number')
    .map((b) => ({ workout_id: b.workout_id, best: r1(b.best) }))
  const payload: LastSetsPayload = { sets: rows<LastSet>(sR), best_e1rm: bests[0]?.best ?? null, bests }
  return json(payload)
}
