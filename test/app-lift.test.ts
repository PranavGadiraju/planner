import { describe, expect, it } from 'vitest'
import type { Exercise, SetRow, Workout } from '@shared/types'
import {
  autoCloseEnd, bestE1rm, findExerciseByName, fmtVolume, fmtWeight, isPR, lastSessionSets, monthLabel, nextSetNo, normName, prefillSet,
  summaryLine, templateExerciseOrder, templateNames, workoutMinutes, workoutStats,
} from '../src/app/data/lift'

const T0 = '2026-09-24T14:00:00.000Z'
const at = (min: number) => new Date(new Date(T0).getTime() + min * 60000).toISOString()
const setRow = (o: Partial<SetRow> & { set_no: number; reps: number; weight: number }): SetRow => ({
  id: o.id ?? `s${o.set_no}`, workout_id: o.workout_id ?? 'w-cur', exercise_id: o.exercise_id ?? 'bench', is_warmup: o.is_warmup ?? 0,
  ts: o.ts ?? at(o.set_no), updated_at: o.updated_at ?? T0, deleted_at: o.deleted_at ?? null, set_no: o.set_no, reps: o.reps, weight: o.weight,
})
const workout = (o: Partial<Workout> & { id: string; started_at: string }): Workout => ({
  name: null, ended_at: null, local_day: '2026-09-24', note: null, ended_by: null, created_at: o.started_at, updated_at: o.started_at, deleted_at: null, ...o,
})

describe('pre-fill rule', () => {
  const template = [setRow({ set_no: 1, reps: 8, weight: 135, workout_id: 'w-push' }), setRow({ set_no: 2, reps: 8, weight: 140, workout_id: 'w-push' })]
  const lastEver = [setRow({ set_no: 3, reps: 5, weight: 150, workout_id: 'w-old' }), setRow({ set_no: 2, reps: 5, weight: 145, workout_id: 'w-old' })]
  it('set N comes from the last same-name workout\'s set N', () => {
    expect(prefillSet(2, { templateSets: template, currentSets: [setRow({ set_no: 1, reps: 10, weight: 95 })], lastEver })).toEqual({ reps: 8, weight: 140, source: 'template' })
  })
  it('falls back to set N-1 of this workout when the template has no set N', () => {
    const current = [setRow({ set_no: 1, reps: 8, weight: 135 }), setRow({ set_no: 2, reps: 7, weight: 135 })]
    expect(prefillSet(3, { templateSets: template, currentSets: current, lastEver })).toEqual({ reps: 7, weight: 135, source: 'previous' })
  })
  it('skips a deleted set N-1 and uses the highest live set below N', () => {
    const current = [setRow({ set_no: 1, reps: 8, weight: 135 }), setRow({ set_no: 2, reps: 7, weight: 135, deleted_at: T0 })]
    expect(prefillSet(3, { templateSets: [], currentSets: current, lastEver })).toEqual({ reps: 8, weight: 135, source: 'previous' })
  })
  it('falls back to the exercise\'s last logged set ever, then to 8 x 0', () => {
    expect(prefillSet(1, { templateSets: [], currentSets: [], lastEver })).toEqual({ reps: 5, weight: 150, source: 'last' })
    expect(prefillSet(1, { templateSets: [], currentSets: [], lastEver: [] })).toEqual({ reps: 8, weight: 0, source: 'default' })
  })
  it('ignores tombstoned template sets', () => {
    const tpl = [setRow({ set_no: 1, reps: 8, weight: 135, workout_id: 'w-push', deleted_at: T0 })]
    expect(prefillSet(1, { templateSets: tpl, currentSets: [], lastEver }).source).toBe('last')
  })
})

describe('PR detection', () => {
  it('135 x 8 = e1RM 171 and beats a lower history', () => {
    expect(bestE1rm([setRow({ set_no: 1, reps: 8, weight: 135 })])).toBe(171)
    expect(isPR({ reps: 8, weight: 135, is_warmup: 0 }, 170)).toBe(true)
    expect(isPR({ reps: 8, weight: 135, is_warmup: 0 }, 171)).toBe(false) // equal is not a PR
    expect(isPR({ reps: 8, weight: 135, is_warmup: 0 }, null)).toBe(true) // first ever working set
  })
  it('warm-ups never count, neither as a PR nor in the history they are compared with', () => {
    expect(isPR({ reps: 20, weight: 500, is_warmup: 1 }, 100)).toBe(false)
    expect(bestE1rm([setRow({ set_no: 1, reps: 20, weight: 500, is_warmup: 1 }), setRow({ set_no: 2, reps: 5, weight: 100 })])).toBe(116.7)
    expect(bestE1rm([setRow({ set_no: 1, reps: 10, weight: 95, is_warmup: 1 })])).toBeNull()
  })
  it('a deleted set drops out of the history', () => {
    expect(bestE1rm([setRow({ set_no: 1, reps: 8, weight: 200, deleted_at: T0 }), setRow({ set_no: 2, reps: 8, weight: 135 })])).toBe(171)
  })
})

describe('set numbering', () => {
  it('continues from the highest live set_no of that exercise in that workout', () => {
    const sets = [
      setRow({ set_no: 1, reps: 8, weight: 135 }), setRow({ set_no: 2, reps: 8, weight: 135 }),
      setRow({ set_no: 1, reps: 10, weight: 50, exercise_id: 'fly' }), setRow({ set_no: 9, reps: 8, weight: 135, workout_id: 'w-other' }),
    ]
    expect(nextSetNo(sets, 'w-cur', 'bench')).toBe(3)
    expect(nextSetNo(sets, 'w-cur', 'fly')).toBe(2)
    expect(nextSetNo(sets, 'w-cur', 'squat')).toBe(1)
  })
  it('a deleted last set frees its number', () => {
    const sets = [setRow({ set_no: 1, reps: 8, weight: 135 }), setRow({ set_no: 2, reps: 8, weight: 135, deleted_at: T0 })]
    expect(nextSetNo(sets, 'w-cur', 'bench')).toBe(2)
  })
})

describe('template population', () => {
  it('orders distinct exercises by first appearance (ts, then set_no), skipping tombstones', () => {
    const sets = [
      setRow({ set_no: 1, reps: 8, weight: 135, exercise_id: 'bench', ts: at(0) }),
      setRow({ set_no: 1, reps: 10, weight: 50, exercise_id: 'fly', ts: at(20) }),
      setRow({ set_no: 2, reps: 8, weight: 135, exercise_id: 'bench', ts: at(3) }),
      setRow({ set_no: 1, reps: 12, weight: 30, exercise_id: 'gone', ts: at(1), deleted_at: T0 }),
      setRow({ set_no: 1, reps: 8, weight: 60, exercise_id: 'ohp', ts: at(10) }),
    ]
    expect(templateExerciseOrder(sets)).toEqual(['bench', 'ohp', 'fly'])
  })
  it('template chips are the last 5 distinct names by recency, case-insensitive', () => {
    const list = [
      workout({ id: '1', name: 'Push', started_at: at(0) }), workout({ id: '2', name: 'pull', started_at: at(60) }),
      workout({ id: '3', name: 'Legs', started_at: at(120) }), workout({ id: '4', name: 'Push ', started_at: at(180) }),
      workout({ id: '5', name: null, started_at: at(240) }), workout({ id: '6', name: 'Upper', started_at: at(300) }),
      workout({ id: '7', name: 'Arms', started_at: at(360) }), workout({ id: '8', name: 'Core', started_at: at(420) }),
      workout({ id: '9', name: 'Old', started_at: at(-60), deleted_at: T0 }),
    ]
    expect(templateNames(list)).toEqual(['Core', 'Arms', 'Upper', 'Push', 'Legs'])
    expect(templateNames(list, 2)).toEqual(['Core', 'Arms'])
  })
  it('matches exercise names case-insensitively and trimmed so a typo cannot fragment history', () => {
    const ex: Exercise[] = [
      { id: 'b', name: 'Bench press', muscle: null, load_type: 'weight', weight_step: 5, use_count: 3, last_used_at: null, created_at: T0, updated_at: T0, deleted_at: null },
      { id: 'x', name: 'Deleted', muscle: null, load_type: 'weight', weight_step: 5, use_count: 3, last_used_at: null, created_at: T0, updated_at: T0, deleted_at: T0 },
    ]
    expect(findExerciseByName(ex, '  bench   PRESS ')?.id).toBe('b')
    expect(findExerciseByName(ex, 'Bench')).toBeNull()
    expect(findExerciseByName(ex, 'deleted')).toBeNull()
    expect(normName(' Bench   Press ')).toBe('bench press')
  })
})

describe('summaries', () => {
  it('counts working sets, volume and exercises like the Worker does', () => {
    const sets = [
      setRow({ set_no: 1, reps: 10, weight: 95, is_warmup: 1 }), setRow({ set_no: 2, reps: 8, weight: 135 }), setRow({ set_no: 3, reps: 8, weight: 135 }),
      setRow({ set_no: 1, reps: 12, weight: 40, exercise_id: 'fly' }), setRow({ set_no: 2, reps: 12, weight: 40, exercise_id: 'fly', deleted_at: T0 }),
    ]
    expect(workoutStats(sets)).toEqual({ sets: 3, volume: 2640, exercises: 2 })
    expect(summaryLine(52.4, { sets: 18, volume: 7420, exercises: 6 }, 2, 'lb')).toBe('52 min · 18 sets · 7,420 lb · 2 PRs')
    expect(summaryLine(75, { sets: 1, volume: 0, exercises: 1 }, 0, 'kg')).toBe('1h15 · 1 set · 0 kg')
    expect(fmtVolume(7420.4, 'lb')).toBe('7,420 lb')
    expect(fmtWeight(62.5)).toBe('62.5')
    expect(fmtWeight(135)).toBe('135')
  })
  it('elapsed minutes use ended_at, or now for a running workout', () => {
    const w = workout({ id: 'w', started_at: T0, ended_at: at(52) })
    expect(workoutMinutes(w, new Date(at(500)))).toBe(52)
    expect(workoutMinutes({ ...w, ended_at: null }, new Date(at(12)))).toBe(12)
  })
  it('auto-close lands 2 min after the last live set (or the start when nothing was logged)', () => {
    const w = workout({ id: 'w', started_at: T0 })
    expect(autoCloseEnd(w, [setRow({ set_no: 1, reps: 8, weight: 135, ts: at(30) }), setRow({ set_no: 2, reps: 8, weight: 135, ts: at(90), deleted_at: T0 })])).toBe(at(32))
    expect(autoCloseEnd(w, [])).toBe(at(2))
  })
  it('ghost line: the most recent earlier session, oldest set first, skipping the current workout', () => {
    const p = {
      best_e1rm: 171,
      sets: [
        { ...setRow({ set_no: 1, reps: 8, weight: 140, workout_id: 'w-cur', ts: at(100) }), local_day: '2026-09-28', workout_name: 'Push' },
        { ...setRow({ set_no: 3, reps: 7, weight: 135, workout_id: 'w-prev', ts: at(-1000) }), local_day: '2026-09-24', workout_name: 'Push' },
        { ...setRow({ set_no: 2, reps: 8, weight: 135, workout_id: 'w-prev', ts: at(-1005) }), local_day: '2026-09-24', workout_name: 'Push' },
        { ...setRow({ set_no: 1, reps: 8, weight: 135, workout_id: 'w-prev', ts: at(-1010) }), local_day: '2026-09-24', workout_name: 'Push' },
        { ...setRow({ set_no: 1, reps: 8, weight: 130, workout_id: 'w-older', ts: at(-5000) }), local_day: '2026-09-20', workout_name: 'Push' },
      ],
    }
    const g = lastSessionSets(p, 'w-cur')
    expect(g?.day).toBe('2026-09-24')
    expect(g?.sets.map((s) => `${s.weight}×${s.reps}`)).toEqual(['135×8', '135×8', '135×7'])
    expect(lastSessionSets(undefined, null)).toBeNull()
    expect(monthLabel('2026-09-24')).toBe('September 2026')
  })
})
