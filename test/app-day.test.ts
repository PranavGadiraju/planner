import { describe, expect, it } from 'vitest'
import { buildDay, type DayInput, type DayResult } from '@shared/day'
import type { TimeBlock } from '@shared/types'
import {
  applyRange, clearRange, daysTouched, gapNeighbours, hm, hourDominant, insertBlock, minuteOf, ringSummary, stripSegments, toBlockCategory,
} from '../src/app/data/daymath'
import { parseHash } from '../src/app/router'

const TZ = 'America/New_York'
const DAY = '2026-09-28'
const local = (day: string, hhmm: string, off = '-04:00') => new Date(`${day}T${hhmm}:00${off}`).toISOString()

/** A realistic morning: slept 23:20-06:52, shower 06:55-07:10, run 07:15-07:56, breakfast block, now 10:30. */
function morning(): DayResult {
  const now = new Date(local(DAY, '10:30'))
  const input: DayInput = {
    day: DAY, tz: TZ, now,
    time_blocks: [{ id: 'b1', start_ts: local(DAY, '08:00'), end_ts: local(DAY, '08:20'), category: 'meal', label: 'Breakfast', project_id: null, source: 'app', created_at: '', updated_at: '', deleted_at: null }],
    sleep: [{ night_of: '2026-09-27', bed_ts: local('2026-09-27', '23:20'), wake_ts: local(DAY, '06:52'), bed_source: 'nfc', wake_source: 'routine', target_bed: '23:00', late_min: 20, updated_at: '', deleted_at: null }],
    workouts: [], sessions: [],
    routine_log: [
      { local_day: DAY, item_id: 'shower', started_at: local(DAY, '06:55'), ended_at: local(DAY, '07:10'), source: 'nfc', updated_at: '', deleted_at: null },
      { local_day: DAY, item_id: 'run', started_at: local(DAY, '07:15'), ended_at: local(DAY, '07:56'), source: 'nfc', updated_at: '', deleted_at: null },
    ],
    routine_items: [
      { id: 'shower', name: 'Shower', icon: null, position: 1, default_min: 15, chart_category: 'routine', active: 1, updated_at: '', deleted_at: null },
      { id: 'run', name: 'Morning run', icon: null, position: 2, default_min: 40, chart_category: 'workout', active: 1, updated_at: '', deleted_at: null },
    ],
    screen_intervals: [], screen_hours: [], app_categories: [],
  }
  return buildDay(input)
}

const sumBlocks = (r: DayResult) => r.blocks.reduce((a, b) => a + b.minutes, 0)
const sumTotals = (r: DayResult) => {
  const t = r.totals
  return t.sleep_s + t.workout_s + t.study_s + t.routine_s + t.mac_s + t.phone_s + t.manual_s + t.unknown_s
}

describe('day helpers', () => {
  it('formats minutes as h m', () => {
    expect(hm(0)).toBe('0m')
    expect(hm(45)).toBe('45m')
    expect(hm(60)).toBe('1h')
    expect(hm(580)).toBe('9h 40m')
    expect(hm(65.4)).toBe('1h 5m')
  })
  it('measures minutes from the day start', () => {
    const r = morning()
    expect(minuteOf(local(DAY, '07:15'), r.start)).toBe(435)
    expect(minuteOf(r.start, r.start)).toBe(0)
  })
  it('summarises the ring and orders the strip', () => {
    const r = morning()
    const { known, unknown } = ringSummary(r.totals)
    expect(known + unknown).toBe(r.now_min)
    const segs = stripSegments(r.totals)
    expect(segs.map((s) => s.category)).toEqual(['sleep', 'workout', 'routine', 'other', 'unknown'])
    expect(segs.reduce((a, s) => a + s.share, 0)).toBeCloseTo(1, 6)
    expect(segs.find((s) => s.category === 'other')?.minutes).toBe(20)
  })
})

describe('hourDominant', () => {
  it('picks the category with the most minutes per hour and leaves future hours empty', () => {
    const r = morning()
    const h = hourDominant(r)
    expect(h.length).toBe(24)
    expect(h.slice(0, 6)).toEqual(['sleep', 'sleep', 'sleep', 'sleep', 'sleep', 'sleep'])
    expect(h[6]).toBe('sleep') // 06:00-06:52 sleep beats 3 min of shower and 5 min unknown
    expect(h[7]).toBe('workout') // the run (41 min) beats the shower tail and breakfast
    expect(h[8]).toBe('unknown') // 20 min breakfast vs 40 min unknown
    expect(h[10]).toBe('unknown') // only 10:00-10:30 elapsed, all unknown
    expect(h[11]).toBe(null)
    expect(h[23]).toBe(null)
  })
  it('ties go to the earlier block', () => {
    const r = morning()
    const start = r.start
    const t = (min: number) => new Date(new Date(start).getTime() + min * 60000).toISOString()
    const blocks = [
      { start: t(0), end: t(30), minutes: 30, category: 'study' as const, sub: null, label: 'A', source: 'session' },
      { start: t(30), end: t(60), minutes: 30, category: 'routine' as const, sub: null, label: 'B', source: 'routine' },
    ]
    expect(hourDominant({ start, blocks })[0]).toBe('study')
  })
})

describe('optimistic gap patch', () => {
  const fill = (): TimeBlock => ({
    id: 'new', start_ts: local(DAY, '08:20'), end_ts: local(DAY, '09:00'), category: 'chores', label: 'Dishes', project_id: null,
    source: 'app', created_at: '', updated_at: '', deleted_at: null,
  })
  it('splits the gap, keeps every minute accounted for and updates the totals', () => {
    const r = morning()
    const before = r.gaps.find((g) => g.start === local(DAY, '08:20'))
    expect(before?.minutes).toBe(130) // 08:20-10:30
    const p = insertBlock(r, fill())
    expect(sumBlocks(p)).toBe(r.now_min)
    expect(sumTotals(p)).toBe(r.now_min * 60)
    expect(p.totals.unknown_s).toBe(r.totals.unknown_s - 40 * 60)
    expect(p.totals.manual_s).toBe(r.totals.manual_s + 40 * 60)
    expect(p.manual_by_category.chores).toBe(40 * 60)
    const inserted = p.blocks.find((b) => b.label === 'Dishes')
    expect(inserted).toMatchObject({ category: 'chores', source: 'manual', minutes: 40, start: local(DAY, '08:20'), end: local(DAY, '09:00') })
    // 06:52-06:55 (3 min) and 07:56-08:00 (4 min) stay absorbed into their neighbours; only real gaps remain.
    expect(p.gaps.map((g) => [g.start, g.minutes])).toEqual([
      [local(DAY, '07:10'), 5],
      [local(DAY, '09:00'), 90],
    ])
    expect(r.gaps.map((g) => g.minutes)).toEqual([5, 130]) // the input is untouched
  })
  it('manual blocks override whatever was there, and clearing turns the range back into Unknown', () => {
    const r = morning()
    const over: TimeBlock = { ...fill(), start_ts: local(DAY, '07:00'), end_ts: local(DAY, '07:30'), category: 'rest', label: null }
    const p = insertBlock(r, over)
    expect(p.blocks.find((b) => b.source === 'manual' && b.label === 'Rest')?.minutes).toBe(30)
    expect(p.totals.routine_s).toBe(r.totals.routine_s - 10 * 60) // 07:00-07:10 of the shower
    expect(p.totals.workout_s).toBe(r.totals.workout_s - 15 * 60) // 07:15-07:30 of the run
    expect(sumTotals(p)).toBe(r.now_min * 60)
    const c = clearRange(p, over.start_ts, over.end_ts)
    expect(c.totals.unknown_s).toBe(p.totals.unknown_s + 30 * 60)
    expect(c.gaps.some((g) => g.start === local(DAY, '07:00') && g.minutes === 30)).toBe(true)
    expect(sumBlocks(c)).toBe(r.now_min)
  })
  it('never draws past now and ignores empty ranges', () => {
    const r = morning()
    const late: TimeBlock = { ...fill(), start_ts: local(DAY, '10:00'), end_ts: local(DAY, '12:00') }
    const p = insertBlock(r, late)
    expect(sumBlocks(p)).toBe(r.now_min)
    expect(p.blocks[p.blocks.length - 1]).toMatchObject({ label: 'Dishes', minutes: 30 })
    expect(applyRange(r, local(DAY, '12:00'), local(DAY, '13:00'), null)).toBe(r)
  })
  it('finds the neighbours of a gap and maps categories for copying', () => {
    const r = morning()
    const gap = r.gaps.find((g) => g.start === local(DAY, '08:20'))!
    const { prev, next } = gapNeighbours(r, gap)
    expect(prev?.label).toBe('Breakfast')
    expect(next).toBeNull()
    expect(toBlockCategory('mac')).toBe('other')
    expect(toBlockCategory('sleep')).toBe('sleep')
  })
})

describe('daysTouched', () => {
  it('maps rows to the local days whose chart they change', () => {
    expect(daysTouched('time_blocks', { start_ts: local(DAY, '23:30'), end_ts: local('2026-09-29', '00:30') }, TZ)).toEqual([DAY, '2026-09-29'])
    expect(daysTouched('time_blocks', { start_ts: local(DAY, '08:00'), end_ts: local(DAY, '09:00') }, TZ)).toEqual([DAY])
    expect(daysTouched('sleep', { night_of: '2026-09-27' }, TZ)).toEqual(['2026-09-27', DAY])
    expect(daysTouched('routine_log', { local_day: DAY }, TZ)).toEqual([DAY])
    expect(daysTouched('settings', { key: 'tz' }, TZ)).toBe('all')
  })
})

describe('day routes', () => {
  it('parses #/day and #/day/YYYY-MM-DD', () => {
    expect(parseHash('#/day')).toEqual({ name: 'day', date: null })
    expect(parseHash('#/day/2026-09-27')).toEqual({ name: 'day', date: '2026-09-27' })
    expect(parseHash('#/day/nope')).toEqual({ name: 'today' })
  })
})
