// POST /api/sets — the Claude Code helper: log sets from text or a notebook photo in one call.
// {workout_id | new_workout: {name, open?, started_at?, ended_at?}, exercise: name|id, sets: [{reps, weight, is_warmup?}] | reps + weight [+ count]}
// -> 201 {workout_id, exercise_id, set_ids, created: {workout, exercise}}. The exercise is matched by id or by
// trimmed case-insensitive name and created when unknown; set_no continues from the max for that exercise in that workout.
import type { RouteContext } from '../../env'
import { json, readJson } from '../../http'
import { HttpError } from '../../http'
import { upsertFor } from '../../db'
import { localDay } from '../../../shared/tz'
import type { Exercise, SetRow, Workout } from '../../../shared/types'
import { parseSetsBody } from './logic'

const FIND_EXERCISE_SQL =
  'SELECT * FROM exercises WHERE deleted_at IS NULL AND (id = ? OR lower(trim(name)) = ?) ORDER BY (id = ?) DESC, use_count DESC, created_at LIMIT 1'
const MAX_SET_NO_SQL =
  'SELECT MAX(set_no) AS n FROM sets WHERE workout_id = ? AND deleted_at IS NULL AND exercise_id = (' +
  'SELECT id FROM exercises WHERE deleted_at IS NULL AND (id = ? OR lower(trim(name)) = ?) ORDER BY (id = ?) DESC, use_count DESC, created_at LIMIT 1)'
const DIRTY_SQL = 'INSERT INTO dirty_days (local_day, marked_at) VALUES (?, ?) ON CONFLICT(local_day) DO UPDATE SET marked_at = excluded.marked_at'

export async function postSets(c: RouteContext): Promise<Response> {
  const { env, now } = c
  const body = parseSetsBody(await readJson<unknown>(c.request))
  const db = env.DB
  const tz = env.TZ
  const nowIso = now.toISOString()
  const key = body.exercise.toLowerCase()

  // One read batch: the exercise (by id or name), the target workout, the next set_no for that pair and the
  // workout's last set timestamp (appended sets must sort after it).
  const reads = [db.prepare(FIND_EXERCISE_SQL).bind(body.exercise, key, body.exercise)]
  if (body.workoutId) {
    reads.push(db.prepare('SELECT * FROM workouts WHERE id = ? AND deleted_at IS NULL LIMIT 1').bind(body.workoutId))
    reads.push(db.prepare(MAX_SET_NO_SQL).bind(body.workoutId, body.exercise, key, body.exercise))
    reads.push(db.prepare('SELECT MAX(ts) AS t FROM sets WHERE workout_id = ? AND deleted_at IS NULL').bind(body.workoutId))
  }
  const [exR, wR, maxR, tsR] = await db.batch(reads)
  const found = ((exR?.results ?? []) as Exercise[])[0] ?? null
  const existing = ((wR?.results ?? []) as Workout[])[0] ?? null
  if (body.workoutId && !existing) throw new HttpError(404, 'workout not found')
  const maxNo = Number(((maxR?.results ?? []) as { n: number | null }[])[0]?.n ?? 0)
  const lastTs = ((tsR?.results ?? []) as { t: string | null }[])[0]?.t ?? null

  const exercise: Exercise = found
    ? { ...found, use_count: found.use_count + 1, last_used_at: nowIso, updated_at: nowIso }
    : {
        id: crypto.randomUUID(), name: body.exercise, muscle: null, load_type: 'weight', weight_step: 5, use_count: 1, last_used_at: nowIso,
        created_at: nowIso, updated_at: nowIso, deleted_at: null,
      }
  let workout: Workout
  if (existing) workout = existing
  else {
    const nw = body.newWorkout
    const startedAt = nw?.started_at ?? nowIso
    const open = nw?.open === true
    // A CLI-logged workout is finished as soon as it is written (open=true keeps it running for the app): it ends
    // now, or at the given ended_at, or one hour after an explicit back-dated start (never "yesterday until now").
    const endedAt = open ? null : nw?.ended_at ?? (nw?.started_at ? new Date(new Date(startedAt).getTime() + 3600_000).toISOString() : nowIso)
    workout = {
      id: crypto.randomUUID(), name: nw?.name ?? null, started_at: startedAt, ended_at: endedAt, local_day: localDay(startedAt, tz), note: null,
      ended_by: open ? null : 'user', created_at: nowIso, updated_at: nowIso, deleted_at: null,
    }
  }

  // Sets are stamped one second apart, after the workout's last set (a running workout: now; a finished one: its
  // end; a new one: its start), so "earlier set" stays well defined for PRs and the detail order is stable.
  const anchor = existing ? (existing.ended_at ? new Date(existing.ended_at).getTime() : now.getTime()) : new Date(workout.started_at).getTime()
  const base = Math.max(anchor, lastTs ? new Date(lastTs).getTime() + 1000 : 0)
  const sets: SetRow[] = body.sets.map((s, i) => ({
    id: crypto.randomUUID(), workout_id: workout.id, exercise_id: exercise.id, set_no: maxNo + i + 1, reps: s.reps, weight: s.weight,
    is_warmup: s.is_warmup, ts: new Date(base + i * 1000).toISOString(), updated_at: nowIso, deleted_at: null,
  }))

  const writes: D1PreparedStatement[] = []
  const put = (table: string, row: object) => {
    const u = upsertFor(table, row, false) // server-authoritative
    writes.push(db.prepare(u.sql).bind(...u.params))
  }
  put('exercises', exercise)
  if (!existing) put('workouts', workout)
  for (const s of sets) put('sets', s)
  if (workout.local_day < localDay(now, tz)) writes.push(db.prepare(DIRTY_SQL).bind(workout.local_day, nowIso))
  await db.batch(writes)

  return json(
    { workout_id: workout.id, exercise_id: exercise.id, set_ids: sets.map((s) => s.id), created: { workout: !existing, exercise: !found } },
    201,
  )
}
