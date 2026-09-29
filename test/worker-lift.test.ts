import { describe, expect, it } from 'vitest'
import { HttpError } from '../src/worker/http'
import { buildHistory, parseBefore, parseLimit, parseRange, parseSetsBody, rangeStart, type HistoryRow } from '../src/worker/routes/lift/logic'
import { matchRoute } from '../src/worker/router'

const row = (workout: string, day: string, set_no: number, reps: number, weight: number, is_warmup = 0): HistoryRow => ({
  workout_id: workout, local_day: day, started_at: `${day}T14:00:00.000Z`, name: 'Push',
  id: `${workout}-${set_no}`, set_no, reps, weight, is_warmup, ts: `${day}T14:${String(set_no).padStart(2, '0')}:00.000Z`,
})

describe('buildHistory', () => {
  it('groups rows into sessions with best e1RM, volume, top set and total reps (warm-ups excluded)', () => {
    const rows = [
      row('w1', '2026-09-20', 1, 10, 95, 1), // warm-up: no volume, no e1RM
      row('w1', '2026-09-20', 2, 8, 135),
      row('w1', '2026-09-20', 3, 8, 135),
      row('w1', '2026-09-20', 4, 6, 145),
    ]
    const [s] = buildHistory(rows)
    expect(s).toBeDefined()
    if (!s) throw new Error('unreachable')
    expect(s.sets).toHaveLength(4)
    expect(s.volume).toBe(8 * 135 * 2 + 6 * 145)
    expect(s.total_reps).toBe(22)
    expect(s.best_e1rm).toBe(174) // 145 x 6 = 145 * 1.2 = 174
    expect(s.top_set).toEqual({ reps: 6, weight: 145 })
    expect(s.is_pr).toBe(true)
    expect(s).toMatchObject({ workout_id: 'w1', local_day: '2026-09-20', name: 'Push' })
  })
  it('135 x 8 is an e1RM of 171 (epley)', () => {
    const [s] = buildHistory([row('w1', '2026-09-20', 1, 8, 135)])
    expect(s?.best_e1rm).toBe(171)
  })
  it('flags PR sessions only when the best beats every earlier session', () => {
    const rows = [
      row('w1', '2026-09-01', 1, 8, 135), // 171 PR
      row('w2', '2026-09-08', 1, 8, 135), // 171 equal: not a PR
      row('w3', '2026-09-15', 1, 8, 140), // 177.3 PR
      row('w4', '2026-09-22', 1, 5, 150), // 175 no
    ]
    expect(buildHistory(rows).map((s) => s.is_pr)).toEqual([true, false, true, false])
  })
  it('a best from before the range stops the first session in the range from being a fake PR', () => {
    const rows = [row('w3', '2026-09-15', 1, 8, 135), row('w4', '2026-09-22', 1, 8, 140)]
    expect(buildHistory(rows, 180).map((s) => s.is_pr)).toEqual([false, false])
    expect(buildHistory(rows, 171).map((s) => s.is_pr)).toEqual([false, true])
    expect(buildHistory(rows, null).map((s) => s.is_pr)).toEqual([true, true])
  })
  it('a warm-up-only session has no e1RM and is never a PR', () => {
    const [s] = buildHistory([row('w1', '2026-09-20', 1, 10, 95, 1)])
    expect(s?.best_e1rm).toBeNull()
    expect(s?.top_set).toBeNull()
    expect(s?.is_pr).toBe(false)
    expect(s?.volume).toBe(0)
  })
  it('returns no sessions for no rows', () => {
    expect(buildHistory([])).toEqual([])
  })
})

describe('range parsing', () => {
  const now = new Date('2026-09-28T12:00:00.000Z')
  it('accepts the four ranges (case-insensitive, default all) and rejects others', () => {
    expect(parseRange(null)).toBe('all')
    expect(parseRange('1M')).toBe('1m')
    expect(parseRange('3m')).toBe('3m')
    expect(parseRange('1y')).toBe('1y')
    expect(() => parseRange('2w')).toThrow(HttpError)
  })
  it('computes the cut-off instant', () => {
    expect(rangeStart('all', now)).toBeNull()
    expect(rangeStart('1m', now)).toBe('2026-08-29T12:00:00.000Z')
    expect(rangeStart('3m', now)).toBe('2026-06-29T12:00:00.000Z')
    expect(rangeStart('1y', now)).toBe('2025-09-28T12:00:00.000Z')
  })
  it('parses limit and before', () => {
    expect(parseLimit(null, 50, 200)).toBe(50)
    expect(parseLimit('10', 50, 200)).toBe(10)
    expect(parseLimit('999', 50, 200)).toBe(200)
    expect(() => parseLimit('0', 50, 200)).toThrow('limit must be a positive integer')
    expect(() => parseLimit('abc', 50, 200)).toThrow(HttpError)
    expect(parseBefore(null)).toBeNull()
    expect(parseBefore('2026-09-28T12:00:00Z')).toBe('2026-09-28T12:00:00.000Z')
    expect(() => parseBefore('yesterday')).toThrow('before must be an ISO timestamp')
  })
})

describe('parseSetsBody', () => {
  it('expands reps + weight + count into identical sets for a new workout', () => {
    const b = parseSetsBody({ new_workout: { name: 'Push' }, exercise: 'Bench press', reps: 8, weight: 135, count: 3 })
    expect(b).toEqual({
      workoutId: null, newWorkout: { name: 'Push', open: false, started_at: null, ended_at: null }, exercise: 'Bench press',
      sets: [{ reps: 8, weight: 135, is_warmup: 0 }, { reps: 8, weight: 135, is_warmup: 0 }, { reps: 8, weight: 135, is_warmup: 0 }],
    })
  })
  it('takes an explicit sets[] for an existing workout, defaulting weight to 0 and mapping warm-ups', () => {
    const b = parseSetsBody({ workout_id: 'w1', exercise: 'e1', sets: [{ reps: 12 }, { reps: 5, weight: 225, is_warmup: true }, { reps: 8, weight: 60, is_warmup: 1 }] })
    expect(b.workoutId).toBe('w1')
    expect(b.newWorkout).toBeNull()
    expect(b.sets).toEqual([{ reps: 12, weight: 0, is_warmup: 0 }, { reps: 5, weight: 225, is_warmup: 1 }, { reps: 8, weight: 60, is_warmup: 1 }])
  })
  it('keeps a workout open and back-dates it when asked', () => {
    const b = parseSetsBody({ new_workout: { name: ' Legs ', open: true, started_at: '2026-09-20T14:00:00Z' }, exercise: 'Squat', reps: 5, weight: 225 })
    expect(b.newWorkout).toEqual({ name: 'Legs', open: true, started_at: '2026-09-20T14:00:00.000Z', ended_at: null })
    expect(b.sets).toHaveLength(1)
    const c = parseSetsBody({ new_workout: { started_at: '2026-09-20T14:00:00Z', ended_at: '2026-09-20T15:00:00Z' }, exercise: 'Squat', reps: 5 })
    expect(c.newWorkout).toEqual({ name: null, open: false, started_at: '2026-09-20T14:00:00.000Z', ended_at: '2026-09-20T15:00:00.000Z' })
  })
  it('a blank name becomes null', () => {
    expect(parseSetsBody({ new_workout: { name: '  ' }, exercise: 'Squat', reps: 5 }).newWorkout?.name).toBeNull()
  })
  it('rejects malformed bodies with 400s', () => {
    const bad = (body: unknown, msg: string) => {
      try {
        parseSetsBody(body)
      } catch (e) {
        expect(e).toBeInstanceOf(HttpError)
        expect((e as HttpError).status).toBe(400)
        expect((e as HttpError).message).toContain(msg)
        return
      }
      throw new Error('expected a 400')
    }
    bad(null, 'JSON object')
    bad({}, 'exercise')
    bad({ exercise: 'x' }, 'workout_id or new_workout required')
    bad({ exercise: 'x', workout_id: 'w', new_workout: {} }, 'not both')
    bad({ exercise: 'x', workout_id: '' }, 'workout_id')
    bad({ exercise: 'x', new_workout: 'Push' }, 'new_workout must be an object')
    bad({ exercise: 'x', new_workout: { name: 3 } }, 'new_workout.name')
    bad({ exercise: 'x', new_workout: { open: 'yes' } }, 'new_workout.open')
    bad({ exercise: 'x', new_workout: { started_at: 'noon' } }, 'started_at')
    bad({ exercise: 'x', new_workout: { ended_at: 'noon' } }, 'ended_at')
    bad({ exercise: 'x', new_workout: { started_at: '2026-09-20T15:00:00Z', ended_at: '2026-09-20T14:00:00Z' } }, 'not be before')
    bad({ exercise: 'x', new_workout: { open: true, ended_at: '2026-09-20T14:00:00Z' } }, 'cannot be combined')
    bad({ exercise: 'x', workout_id: 'w' }, 'sets[] or reps + weight required')
    bad({ exercise: 'x', workout_id: 'w', sets: [] }, 'non-empty array')
    bad({ exercise: 'x', workout_id: 'w', sets: [{ reps: 0 }] }, 'sets[0].reps')
    bad({ exercise: 'x', workout_id: 'w', sets: [{ reps: 2.5 }] }, 'sets[0].reps')
    bad({ exercise: 'x', workout_id: 'w', sets: [{ reps: 8, weight: -5 }] }, 'sets[0].weight')
    bad({ exercise: 'x', workout_id: 'w', sets: [{ reps: 8, is_warmup: 'y' }] }, 'sets[0].is_warmup')
    bad({ exercise: 'x', workout_id: 'w', reps: 8, count: 0 }, 'count')
    bad({ exercise: 'x', workout_id: 'w', sets: Array.from({ length: 101 }, () => ({ reps: 1 })) }, 'at most 100')
  })
})

describe('lift route table', () => {
  // The same paths src/worker/routes/lift.ts registers (that module needs D1 types, so the table is repeated here;
  // scripts/smoke-lift.sh exercises the real registration).
  const routes = [
    { method: 'GET', path: '/api/exercises' }, { method: 'GET', path: '/api/exercises/:id/history' },
    { method: 'GET', path: '/api/workouts' }, { method: 'GET', path: '/api/workouts/:id' },
    { method: 'GET', path: '/api/lift/template' }, { method: 'GET', path: '/api/lift/last-sets' }, { method: 'POST', path: '/api/sets' },
  ]
  it('parameterised paths capture ids without shadowing the literal ones', () => {
    expect(matchRoute(routes, 'GET', '/api/workouts/abc').params).toEqual({ id: 'abc' })
    expect(matchRoute(routes, 'GET', '/api/exercises/e1/history').params).toEqual({ id: 'e1' })
    expect(matchRoute(routes, 'GET', '/api/exercises').route?.path).toBe('/api/exercises')
    expect(matchRoute(routes, 'GET', '/api/lift/template').route?.path).toBe('/api/lift/template')
    expect(matchRoute(routes, 'POST', '/api/workouts')).toMatchObject({ route: null, pathMatched: true })
    expect(matchRoute(routes, 'GET', '/api/sets')).toMatchObject({ route: null, pathMatched: true })
  })
})
