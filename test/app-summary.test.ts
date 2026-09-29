import { describe, expect, it } from 'vitest'
import {
  avgPerDay, bedtimeStats, byDay, dayIndex, deltas, fmtDelta, fmtLate, fmtPct, fmtPoints, fmtSeconds, hasData, isoWeek, kcalAverage, mergeMaps, monthLabel,
  monthOf, pick, routineCompletion, shareDeltas, shares, shiftMonth, soFar, sumDays, unknownShare, weekLabel, weekOf, type DaySummary,
} from '../src/app/data/summary'

function day(local_day: string, patch: Partial<DaySummary> = {}): DaySummary {
  const base: DaySummary = {
    local_day, sleep_s: 7 * 3600, workout_s: 3600, study_s: 2 * 3600, routine_s: 1800, mac_s: 4 * 3600, phone_s: 1800, manual_s: 3600,
    unknown_s: 0, tracked_s: 86400, mac_by_category: { dev: 3 * 3600, comms: 3600 }, study_by_project: { p1: 5400, p2: 1800 }, manual_by_category: { meal: 3600 },
    kcal: 2200, protein_g: 150, carb_g: 220, fat_g: 70, sets_count: 0, volume: 0, sessions_count: 2, routine_done: 4, routine_total: 5, bed_late_min: 10,
    final: 1, computed_at: 'x',
  }
  const d = { ...base, ...patch }
  d.unknown_s = d.tracked_s - (d.sleep_s + d.workout_s + d.study_s + d.routine_s + d.mac_s + d.phone_s + d.manual_s)
  return d
}

describe('periods', () => {
  it('weekOf is Mon-Sun and crosses month and year ends', () => {
    expect(weekOf('2026-09-28')).toEqual({ start: '2026-09-28', end: '2026-10-04', days: ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'] })
    expect(weekOf('2026-10-04').start).toBe('2026-09-28') // Sunday belongs to the week that started Monday
    expect(weekOf('2027-01-01').start).toBe('2026-12-28')
  })
  it('monthOf handles February and December', () => {
    expect(monthOf('2026-02-14')).toMatchObject({ start: '2026-02-01', end: '2026-02-28' })
    expect(monthOf('2026-02-14').days).toHaveLength(28)
    expect(monthOf('2028-02-14').days).toHaveLength(29)
    expect(monthOf('2026-12-31')).toMatchObject({ start: '2026-12-01', end: '2026-12-31' })
  })
  it('shiftMonth wraps years', () => {
    expect(shiftMonth('2026-01-15', -1)).toBe('2025-12-01')
    expect(shiftMonth('2026-12-15', 1)).toBe('2027-01-01')
    expect(shiftMonth('2026-09-15', -13)).toBe('2025-08-01')
  })
  it('labels', () => {
    expect(weekLabel(weekOf('2026-09-22'))).toBe('21–27 Sep')
    expect(weekLabel(weekOf('2026-09-30'))).toBe('28 Sep – 4 Oct')
    expect(monthLabel('2026-09-01')).toBe('September 2026')
    expect(isoWeek('2026-09-28')).toBe(40)
    expect(isoWeek('2026-01-01')).toBe(1)
    expect(isoWeek('2027-01-01')).toBe(53)
  })
  it('dayIndex', () => {
    expect(dayIndex('2026-09-28', '2026-09-28')).toBe(0)
    expect(dayIndex('2026-09-28', '2026-10-01')).toBe(3)
    expect(dayIndex('2026-09-28', '2026-09-27')).toBe(-1)
  })
})

describe('sums and deltas', () => {
  const week = weekOf('2026-09-21')
  const rows = byDay([
    day('2026-09-21'), day('2026-09-22', { sleep_s: 8 * 3600 }), day('2026-09-23'),
    day('2026-09-24', { tracked_s: 0, sleep_s: 0, workout_s: 0, study_s: 0, routine_s: 0, mac_s: 0, phone_s: 0, manual_s: 0 }), // no data
  ])
  it('sumDays skips days without data and averages over the rest', () => {
    const s = sumDays(pick(rows, week.days))
    expect(s.days).toBe(4)
    expect(s.days_with_data).toBe(3)
    expect(s.seconds.sleep).toBe(22 * 3600)
    expect(s.seconds.other).toBe(3 * 3600)
    expect(s.tracked_s).toBe(3 * 86400)
    expect(avgPerDay(s, 'sleep')).toBeCloseTo((22 / 3) * 3600)
    expect(hasData(rows.get('2026-09-24'))).toBe(false)
    expect(hasData(undefined)).toBe(false)
  })
  it('deltas subtract per category', () => {
    const cur = sumDays([day('2026-09-21', { sleep_s: 8 * 3600 })])
    const prev = sumDays([day('2026-09-14', { sleep_s: 7 * 3600, phone_s: 3600 })])
    const d = deltas(cur, prev)
    expect(d.sleep).toBe(3600)
    expect(d.phone).toBe(-1800)
    expect(d.study).toBe(0)
  })
  it('shares sum to 1 and share deltas are in percentage points', () => {
    const sh = shares(sumDays([day('2026-09-21')]))
    const total = Object.values(sh).reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(1)
    expect(sh.sleep).toBeCloseTo(7 / 24)
    const prev = shares(sumDays([day('2026-09-01', { sleep_s: 6 * 3600 })]))
    expect(shareDeltas(sh, prev).sleep).toBeCloseTo((1 / 24) * 100)
    expect(shares(sumDays([])).sleep).toBe(0)
  })
  it('unknownShare is 1 without data', () => {
    expect(unknownShare(undefined)).toBe(1)
    expect(unknownShare(day('2026-09-21'))).toBeCloseTo(8 / 24)
    expect(unknownShare(day('2026-09-21', { tracked_s: 0 }))).toBe(1)
  })
  it('so far compares Mon..today with the same weekdays last week', () => {
    const rows2 = byDay([
      day('2026-09-21', { sleep_s: 7 * 3600 }), day('2026-09-22', { sleep_s: 7 * 3600 }), day('2026-09-23', { sleep_s: 7 * 3600 }), day('2026-09-24'), day('2026-09-25'),
      day('2026-09-28', { sleep_s: 8 * 3600 }), day('2026-09-29', { sleep_s: 8 * 3600 }), day('2026-09-30', { sleep_s: 6 * 3600, tracked_s: 43200 }),
    ])
    const sf = soFar(rows2, '2026-09-28', '2026-09-30')
    expect(sf.through).toBe(2)
    expect(sf.cur.days).toBe(3)
    expect(sf.prev.days).toBe(3)
    expect(sf.cur.seconds.sleep).toBe(22 * 3600)
    expect(sf.prev.seconds.sleep).toBe(21 * 3600)
    // Thursday/Friday of last week are not part of the comparison
    expect(sf.prev.days_with_data).toBe(3)
  })
})

describe('bedtime', () => {
  const days = weekOf('2026-09-21').days
  it('counts nights on target, averages late minutes and finds the current streak', () => {
    const rows = byDay([
      day('2026-09-21', { bed_late_min: 5 }), day('2026-09-22', { bed_late_min: 40 }), day('2026-09-23', { bed_late_min: 0 }),
      day('2026-09-24', { bed_late_min: 15 }), day('2026-09-25', { bed_late_min: -20 }),
    ])
    const b = bedtimeStats(days, rows, 15)
    expect(b.nights).toBe(5)
    expect(b.on_target).toBe(4)
    expect(b.avg_late).toBe(8)
    expect(b.streak).toBe(3) // 23, 24, 25 (26/27 have no row yet)
    expect(b.points).toHaveLength(7)
    expect(b.points[6]).toEqual({ day: '2026-09-27', late: null })
  })
  it('a missing night inside the run breaks the streak; no nights -> nulls', () => {
    const rows = byDay([day('2026-09-21', { bed_late_min: 0 }), day('2026-09-23', { bed_late_min: 0 }), day('2026-09-24', { bed_late_min: 0 })])
    expect(bedtimeStats(days, rows, 15).streak).toBe(2)
    const none = bedtimeStats(days, byDay([day('2026-09-21', { bed_late_min: null })]), 15)
    expect(none).toMatchObject({ nights: 0, on_target: 0, avg_late: null, streak: 0 })
  })
})

describe('breakdowns', () => {
  it('mergeMaps sums the JSON maps largest first and drops zeros', () => {
    const rows = [day('2026-09-21'), day('2026-09-22', { study_by_project: { p2: 7200, p3: 0 } })]
    expect(mergeMaps(rows, 'study_by_project')).toEqual([{ key: 'p2', seconds: 9000 }, { key: 'p1', seconds: 5400 }])
    expect(mergeMaps(rows, 'mac_by_category')[0]).toEqual({ key: 'dev', seconds: 6 * 3600 })
  })
  it('kcalAverage ignores days without food', () => {
    expect(kcalAverage([day('2026-09-21', { kcal: 2000 }), day('2026-09-22', { kcal: null }), day('2026-09-23', { kcal: 2400 })])).toEqual({ avg: 2200, days: 2 })
    expect(kcalAverage([day('2026-09-22', { kcal: null })])).toEqual({ avg: null, days: 0 })
  })
  it('routineCompletion clamps done to total', () => {
    const rows = byDay([day('2026-09-21', { routine_done: 7, routine_total: 5 }), day('2026-09-22', { routine_done: 2, routine_total: 5 })])
    const r = routineCompletion(['2026-09-21', '2026-09-22', '2026-09-23'], rows)
    expect(r.done).toBe(7)
    expect(r.total).toBe(10)
    expect(r.per_day[2]).toEqual({ day: '2026-09-23', done: 0, total: 0 })
  })
})

describe('formatting', () => {
  it('durations and deltas', () => {
    expect(fmtSeconds(52 * 3600 + 600)).toBe('52h 10m')
    expect(fmtSeconds(2700)).toBe('45m')
    expect(fmtSeconds(7200)).toBe('2h')
    expect(fmtSeconds(3900)).toBe('1h 05m')
    expect(fmtSeconds(0)).toBe('0m')
    expect(fmtDelta(3900)).toBe('+1h 05m')
    expect(fmtDelta(-2100)).toBe('−35m')
    expect(fmtDelta(20)).toBe('±0')
  })
  it('points, percentages, late minutes', () => {
    expect(fmtPoints(2.34)).toBe('+2.3')
    expect(fmtPoints(-0.04)).toBe('±0')
    expect(fmtPoints(-3)).toBe('−3')
    expect(fmtPct(0.314)).toBe('31%')
    expect(fmtLate(20)).toBe('+20')
    expect(fmtLate(-5)).toBe('−5')
    expect(fmtLate(0)).toBe('0')
  })
})
