import { describe, expect, it } from 'vitest'
import { applyRoutineTap, routineDurationMin, routineIsDone } from '@shared/routine'
import type { RoutineLog } from '@shared/types'

const ctx = { local_day: '2026-09-28', item_id: 'run', source: 'nfc' as const }
const t = (min: number) => new Date(Date.UTC(2026, 8, 28, 10, min, 0))

describe('routine taps', () => {
  it('first tap starts the item', () => {
    const r = applyRoutineTap(null, t(0), ctx)
    expect(r.action).toBe('routine_started')
    expect(r.row.started_at).toBe(t(0).toISOString())
    expect(r.row.ended_at).toBeNull()
  })
  it('a tap within 2 minutes is a duplicate, 2-3 minutes is ignored, 3+ minutes finishes', () => {
    const started = applyRoutineTap(null, t(0), ctx).row
    expect(applyRoutineTap(started, new Date(t(0).getTime() + 90_000), ctx).action).toBe('routine_duplicate')
    expect(applyRoutineTap(started, new Date(t(0).getTime() + 150_000), ctx).action).toBe('routine_ignored')
    const done = applyRoutineTap(started, t(41), ctx)
    expect(done.action).toBe('routine_finished')
    expect(routineDurationMin(done.row, 40)).toBe(41)
    expect(applyRoutineTap(done.row, t(50), ctx).action).toBe('routine_already_done')
  })
  it('an undone (tombstoned) row is re-activated by a new tap', () => {
    const dead: RoutineLog = { ...applyRoutineTap(null, t(0), ctx).row, deleted_at: t(5).toISOString() }
    const r = applyRoutineTap(dead, t(20), ctx)
    expect(r.action).toBe('routine_started')
    expect(r.row.deleted_at).toBeNull()
    expect(r.row.started_at).toBe(t(20).toISOString())
  })
  it('a tap 3 h or more after the start changes nothing (the item was implicitly done)', () => {
    const started = applyRoutineTap(null, t(0), ctx).row
    const late = new Date(t(0).getTime() + 3 * 3600_000)
    expect(applyRoutineTap(started, late, ctx).action).toBe('routine_already_done')
    expect(routineIsDone(started, late)).toBe(true)
    expect(routineIsDone(started, t(30))).toBe(false)
  })
  it('uses the default duration when only one tap happened', () => {
    expect(routineDurationMin(applyRoutineTap(null, t(0), ctx).row, 15)).toBe(15)
  })
})
