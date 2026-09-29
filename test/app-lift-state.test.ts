// The stateful side of src/app/data/lift.ts: the active workout signal, IndexedDB (idb-keyval mocked with a Map so
// the outbox, the API cache and the persisted workout behave like a browser) and fetch (stubbed per path).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Exercise, SetRow, Workout } from '@shared/types'

const { mem } = vi.hoisted(() => ({ mem: new Map<string, unknown>() }))
vi.mock('idb-keyval', () => ({
  get: async (k: string) => mem.get(k),
  set: async (k: string, v: unknown) => { mem.set(k, v) },
  del: async (k: string) => { mem.delete(k) },
  keys: async () => [...mem.keys()],
  entries: async () => [...mem.entries()],
  clear: async () => { mem.clear() },
}))

import { get, set } from 'idb-keyval'
import * as outbox from '../src/app/data/outbox'
import {
  active, dismissRejection, editSet, exercises, finishWorkout, lastSets, logSet, nextSetNo, onWriteRejected, priorBestFor, rejections, workouts,
  type ActiveState, type LastSetsPayload, type WorkoutBest,
} from '../src/app/data/lift'

const T0 = '2026-09-28T14:00:00.000Z'
const at = (min: number) => new Date(new Date(T0).getTime() + min * 60000).toISOString()
const workout = (id: string, o: Partial<Workout> = {}): Workout => ({
  id, name: 'Push', started_at: T0, ended_at: null, local_day: '2026-09-28', note: null, ended_by: null, created_at: T0, updated_at: T0, deleted_at: null, ...o,
})
const setRow = (id: string, workout_id: string, set_no: number, reps: number, weight: number, o: Partial<SetRow> = {}): SetRow => ({
  id, workout_id, exercise_id: 'bench', set_no, reps, weight, is_warmup: 0, ts: at(set_no), updated_at: T0, deleted_at: null, ...o,
})
const bench: Exercise = { id: 'bench', name: 'Bench press', muscle: null, load_type: 'weight', weight_step: 5, use_count: 3, last_used_at: null, created_at: T0, updated_at: T0, deleted_at: null }
const payload = (bests: WorkoutBest[]): LastSetsPayload => ({ sets: [], best_e1rm: bests[0]?.best ?? null, bests })
const state = (id: string, sets: SetRow[], pr_ids: string[] = []): ActiveState => ({ workout: workout(id), exercise_ids: ['bench'], sets, pr_ids })
const tick = () => new Promise((r) => setTimeout(r, 5))

// fetch: path -> JSON body; anything else is a network failure (so apiGet falls back to its cache, then throws).
const routes = new Map<string, unknown>()
beforeEach(() => {
  mem.clear()
  routes.clear()
  active.value = null
  lastSets.value = {}
  rejections.value = []
  exercises.value = [bench]
  workouts.value = []
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const path = typeof input === 'string' ? input : input instanceof URL ? input.pathname + input.search : new URL(input.url).pathname
    const hit = routes.get(path)
    if (hit === undefined) throw new TypeError(`fetch failed: ${path}`)
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('finishWorkout summary', () => {
  // First test in the file on purpose: ensureActive() restores from IndexedDB once per page (module) load.
  it('Today\'s End after a reload restores the persisted workout and counts its sets (no "0 sets")', async () => {
    const sets = [setRow('s1', 'w-restore', 1, 8, 135), setRow('s2', 'w-restore', 2, 10, 95, { is_warmup: 1 }), setRow('s3', 'w-restore', 3, 8, 140)]
    await set('lift:active', state('w-restore', sets, ['s3']))
    expect(active.value).toBeNull()
    const r = await finishWorkout(workout('w-restore'), at(52))
    expect(r.stats).toEqual({ sets: 2, volume: 2200, exercises: 1 })
    expect(r.prs).toBe(1)
    expect(r.line).toBe('52 min · 2 sets · 2,200 lb · 1 PR')
    expect(active.value).toBeNull()
    expect(await get('lift:active')).toBeUndefined() // the IndexedDB copy is gone with it
    const queued = await outbox.peek()
    expect(queued.map((q) => q.table)).toEqual(['workouts'])
    expect(queued[0]?.row).toMatchObject({ id: 'w-restore', ended_at: at(52), ended_by: 'user' })
  })
  it('a workout run on the other device is summarised from the server\'s copy', async () => {
    routes.set('/api/workouts/w-remote', {
      workout: workout('w-remote'),
      sets: [{ ...setRow('r1', 'w-remote', 1, 8, 135), prior_best: null }, { ...setRow('r2', 'w-remote', 2, 8, 140), prior_best: 171 }, { ...setRow('r3', 'w-remote', 3, 8, 140, { deleted_at: T0 }), prior_best: null }],
      exercises: [bench],
    })
    const r = await finishWorkout(workout('w-remote'), at(40))
    expect(r.stats).toEqual({ sets: 2, volume: 2200, exercises: 1 })
    expect(r.prs).toBe(2)
    expect(r.line).toBe('40 min · 2 sets · 2,200 lb · 2 PRs')
  })
  it('offline with nothing cached the line is the duration alone', async () => {
    const r = await finishWorkout(workout('w-off'), at(75))
    expect(r.stats).toBeNull()
    expect(r.prs).toBe(0)
    expect(r.line).toBe('1h15')
  })
  it('a stale persisted copy of the finished workout is dropped even when it was not restored', async () => {
    await set('lift:active', state('w-stale', [])) // ensureActive already ran (memoised) so this copy is never loaded
    await finishWorkout(workout('w-stale'), at(10))
    await tick()
    expect(await get('lift:active')).toBeUndefined()
    await set('lift:active', state('w-other', []))
    await finishWorkout(workout('w-stale2'), at(10))
    await tick()
    expect(await get('lift:active')).toMatchObject({ workout: { id: 'w-other' } }) // another workout's copy is left alone
  })
})

describe('PR detection with unknown vs known history', () => {
  it('priorBestFor is undefined until last-sets arrived, then the running workout is excluded exactly', () => {
    const a = state('w-cur', [setRow('c1', 'w-cur', 1, 8, 135)])
    expect(priorBestFor(a, 'bench', at(10))).toBeUndefined()
    lastSets.value = { bench: payload([{ workout_id: 'w-cur', best: 300 }, { workout_id: 'w-old', best: 171 }]) }
    expect(priorBestFor(a, 'bench', at(10))).toBe(171) // the 300 is this workout's own synced set, not history
    expect(priorBestFor(a, 'bench', at(0.5))).toBe(171)
    lastSets.value = { bench: payload([{ workout_id: 'w-old', best: 160 }]) }
    expect(priorBestFor(a, 'bench', at(10))).toBe(171) // local earlier set beats the server
    expect(priorBestFor(a, 'bench', at(10), 'c1')).toBe(160) // unless it is the set being edited
    lastSets.value = { bench: payload([{ workout_id: 'w-cur', best: 171 }]) }
    expect(priorBestFor(state('w-cur', []), 'bench', at(10))).toBeNull() // no other workout: a first ever
  })
  it('the first set of a not-yet-loaded exercise is logged without a PR claim, and badged once history says so', async () => {
    active.value = state('w-cur', [])
    routes.set('/api/lift/last-sets?exercise_id=bench', payload([]))
    const r = await logSet('bench', 8, 135, false)
    expect(r.pr).toBe(false)
    expect(active.value?.pr_ids).toEqual([])
    await tick()
    expect(active.value?.pr_ids).toEqual([r.set.id]) // history arrived: it really was the first working set ever
    expect(lastSets.value['bench']).toBeDefined()
  })
  it('with history known a set is a PR only when it beats the best outside this workout', async () => {
    active.value = state('w-cur', [])
    lastSets.value = { bench: payload([{ workout_id: 'w-cur', best: 300 }, { workout_id: 'w-old', best: 171 }]) }
    const same = await logSet('bench', 8, 135, false) // e1RM 171: equal is not a PR
    expect(same.pr).toBe(false)
    const more = await logSet('bench', 8, 140, false) // 177.3
    expect(more.pr).toBe(true)
    expect(active.value?.pr_ids).toEqual([more.set.id])
    expect(active.value?.sets.map((s) => s.set_no)).toEqual([1, 2])
  })
  it('a history that never loads leaves no PR claim behind', async () => {
    active.value = state('w-cur', [])
    const r = await logSet('bench', 8, 135, false)
    await tick()
    expect(r.pr).toBe(false)
    expect(active.value?.pr_ids).toEqual([])
    expect(active.value?.sets).toHaveLength(1) // the set itself was logged at once
  })
  it('editing a set keeps its badge while history is unknown and re-judges it once known', async () => {
    const s1 = setRow('s1', 'w-cur', 1, 8, 135)
    active.value = state('w-cur', [s1], ['s1'])
    await editSet(s1, { weight: 100 })
    expect(active.value?.pr_ids).toEqual(['s1'])
    lastSets.value = { bench: payload([{ workout_id: 'w-old', best: 200 }]) }
    await editSet(s1, { weight: 100 })
    expect(active.value?.pr_ids).toEqual([])
    await editSet(s1, { weight: 170 }) // 215.3
    expect(active.value?.pr_ids).toEqual(['s1'])
  })
})

describe('rejected writes', () => {
  it('a rejected set of the running workout leaves the local mirror and is reported on the workout screen', async () => {
    const sets = [setRow('s1', 'w-cur', 1, 8, 135), setRow('s2', 'w-cur', 2, 8, 140)]
    active.value = state('w-cur', sets, ['s2'])
    workouts.value = [{ ...workout('w-cur'), sets_count: 2, volume: 2200, exercises_count: 1 }]
    onWriteRejected('sets', 's2', 'D1_ERROR: FOREIGN KEY constraint failed')
    expect(active.value?.sets.map((s) => s.id)).toEqual(['s1'])
    expect(active.value?.pr_ids).toEqual([])
    expect(nextSetNo(active.value?.sets ?? [], 'w-cur', 'bench')).toBe(2) // the number is free to log again
    expect(workouts.value[0]).toMatchObject({ sets_count: 1, volume: 1080 })
    expect(rejections.value).toHaveLength(1)
    expect(rejections.value[0]).toMatchObject({ table: 'sets', key: 's2', reason: 'D1_ERROR: FOREIGN KEY constraint failed', label: 'Set 2 of Bench press (140×8) was not saved. Log it again.' })
    await tick()
    expect(await get('lift:active')).toMatchObject({ sets: [{ id: 's1' }] })
    expect(await outbox.peek()).toEqual([]) // local only: nothing was enqueued for it
    dismissRejection(rejections.value[0]?.id ?? -1)
    expect(rejections.value).toEqual([])
  })
  it('other lift tables get a notice, other areas are left to their own screens', () => {
    active.value = state('w-cur', [])
    onWriteRejected('foods', 'f1', 'nope')
    expect(rejections.value).toEqual([])
    onWriteRejected('workouts', 'w-cur', 'missing updated_at')
    onWriteRejected('exercises', 'bench', 'unknown column')
    onWriteRejected('sets', '3 rows', 'at most 200 rows per request')
    expect(rejections.value.map((r) => r.label)).toEqual([
      'This workout was not saved on the server.', 'An exercise was not saved on the server.', 'A set was not saved on the server.',
    ])
    expect(active.value?.sets).toEqual([])
  })
})
