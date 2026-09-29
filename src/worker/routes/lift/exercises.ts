// GET /api/exercises and GET /api/exercises/:id/history (app role).
import type { RouteContext } from '../../env'
import { HttpError, json } from '../../http'
import type { Exercise } from '../../../shared/types'
import { buildHistory, parseRange, rangeStart } from './logic'
import type { HistoryPayload, HistoryRow } from './logic'

/** Epley e1RM in SQL, matching epley1RM() (a single rep is the weight itself). */
export const E1RM_SQL = 'CASE WHEN {s}.reps <= 1 THEN {s}.weight ELSE {s}.weight * (1 + {s}.reps / 30.0) END'
const e1rm = (alias: string) => E1RM_SQL.replaceAll('{s}', alias)

/** Non-deleted exercises, most used first. */
export async function listExercises({ env }: RouteContext): Promise<Response> {
  const { results } = await env.DB
    .prepare('SELECT * FROM exercises WHERE deleted_at IS NULL ORDER BY use_count DESC, name COLLATE NOCASE, id')
    .all<Exercise>()
  return json({ exercises: results })
}

const HISTORY_SQL =
  'SELECT w.id AS workout_id, w.local_day, w.started_at, w.name, s.id, s.set_no, s.reps, s.weight, s.is_warmup, s.ts ' +
  'FROM sets s JOIN workouts w ON w.id = s.workout_id ' +
  'WHERE s.exercise_id = ? AND s.deleted_at IS NULL AND w.deleted_at IS NULL AND (? IS NULL OR w.started_at >= ?) ' +
  'ORDER BY w.started_at, s.ts, s.set_no'
const PRIOR_BEST_SQL =
  `SELECT MAX(${e1rm('s')}) AS best FROM sets s JOIN workouts w ON w.id = s.workout_id ` +
  'WHERE s.exercise_id = ? AND s.is_warmup = 0 AND s.deleted_at IS NULL AND w.deleted_at IS NULL AND (? IS NULL OR w.started_at < ?)'

/** Sessions of one exercise (oldest first) with best e1RM, volume, top set and PR flags; range 1m | 3m | 1y | all. */
export async function exerciseHistory(c: RouteContext): Promise<Response> {
  const { env, now } = c
  const id = c.params['id'] ?? ''
  const range = parseRange(c.url.searchParams.get('range'))
  const since = rangeStart(range, now)
  const db = env.DB
  const [exR, rowsR, bestR] = await db.batch([
    db.prepare('SELECT * FROM exercises WHERE id = ? LIMIT 1').bind(id),
    db.prepare(HISTORY_SQL).bind(id, since, since),
    // The best before the range, so the first session inside it is only a PR when it really beat history.
    db.prepare(PRIOR_BEST_SQL).bind(id, since, since),
  ])
  const exercise = ((exR?.results ?? []) as Exercise[])[0]
  if (!exercise) throw new HttpError(404, 'exercise not found')
  const rows = (rowsR?.results ?? []) as HistoryRow[]
  const priorRaw = ((bestR?.results ?? []) as { best: number | null }[])[0]?.best
  const priorBest = since === null || typeof priorRaw !== 'number' ? null : Math.round(priorRaw * 10) / 10
  const payload: HistoryPayload = { exercise, range, sessions: buildHistory(rows, priorBest) }
  return json(payload)
}
