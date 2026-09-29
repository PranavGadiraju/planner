import { describe, expect, it } from 'vitest'
import { buildDay, type DayInput } from '@shared/day'
import {
  AGGREGATE_SQL, SUMMARY_COLUMNS, SUMMARY_UPSERT_SQL, composeSummary, emptySummary, isFinalDay, parseAggregates, rowDays, rowToSummary, summaryParams,
} from '../src/worker/routes/rollup/summary'
import type { DaySummary, ResultLike } from '../src/worker/routes/rollup/summary'
import { dayRange, planRange, parseRange } from '../src/worker/routes/rollup/range'
import { AUTO_CLOSE_SESSIONS_SQL, AUTO_CLOSE_WORKOUTS_SQL, planRebuilds } from '../src/worker/routes/rollup/nightly'
import { EXPORT_TABLES } from '../src/worker/routes/rollup/tables'
import { HttpError } from '../src/worker/http'

const TZ = 'America/New_York'
const DAY = '2026-09-26'
const local = (day: string, hhmm: string, off = '-04:00') => new Date(`${day}T${hhmm}:00${off}`).toISOString()

function pastDay(): DayInput {
  return {
    day: DAY, tz: TZ, now: new Date(local('2026-09-28', '12:00')),
    time_blocks: [{ id: 'b1', start_ts: local(DAY, '12:00'), end_ts: local(DAY, '13:00'), category: 'meal', label: 'Lunch', project_id: null, source: 'app', created_at: '', updated_at: '', deleted_at: null }],
    sleep: [
      { night_of: '2026-09-25', bed_ts: local('2026-09-25', '23:20'), wake_ts: local(DAY, '06:52'), bed_source: 'nfc', wake_source: 'routine', target_bed: '23:00', late_min: 20, updated_at: '', deleted_at: null },
      { night_of: DAY, bed_ts: local(DAY, '22:50'), wake_ts: local('2026-09-27', '07:00'), bed_source: 'nfc', wake_source: 'routine', target_bed: '23:00', late_min: -10, updated_at: '', deleted_at: null },
    ],
    workouts: [], sessions: [
      { id: 's1', project_id: 'p1', started_at: local(DAY, '14:00'), ended_at: local(DAY, '15:30'), local_day: DAY, duration_s: 5400, note: null, source: 'app', ended_by: 'user', created_at: '', updated_at: '', deleted_at: null, project_name: 'Thesis' },
    ],
    routine_log: [
      { local_day: DAY, item_id: 'shower', started_at: local(DAY, '07:00'), ended_at: local(DAY, '07:15'), source: 'nfc', updated_at: '', deleted_at: null },
    ],
    routine_items: [
      { id: 'shower', name: 'Shower', icon: null, position: 1, default_min: 15, chart_category: 'routine', active: 1, updated_at: '', deleted_at: null },
      { id: 'run', name: 'Run', icon: null, position: 2, default_min: 40, chart_category: 'workout', active: 1, updated_at: '', deleted_at: null },
      { id: 'old', name: 'Old', icon: null, position: 3, default_min: 10, chart_category: 'routine', active: 0, updated_at: '', deleted_at: null },
    ],
    screen_intervals: [], screen_hours: [], app_categories: [],
  }
}

const d1 = (rows: Record<string, unknown>[]): ResultLike => ({ results: rows })

describe('composeSummary', () => {
  it('turns a buildDay result plus the SQL sums into one day_summary row that adds up to the day', () => {
    const input = pastDay()
    const r = buildDay(input)
    const agg = parseAggregates([
      d1([{ n: 3, kcal: 2150, protein_g: 160.5, carb_g: 210, fat_g: 70 }]),
      d1([{ n: 12, volume: 7420 }]),
      d1([{ n: 1 }]),
    ])
    const s = composeSummary(DAY, r, agg, { routine_done: 1, routine_total: 2, bed_late_min: -10, today: '2026-09-28', nowIso: '2026-09-28T16:00:00.000Z' })
    expect(s.local_day).toBe(DAY)
    expect(s.tracked_s).toBe(86400)
    expect(s.sleep_s + s.workout_s + s.study_s + s.routine_s + s.mac_s + s.phone_s + s.manual_s + s.unknown_s).toBe(86400)
    expect(s.sleep_s).toBe((6 * 60 + 52 + 70) * 60) // 00:00-06:52 + 22:50-24:00
    expect(s.routine_s).toBe(15 * 60)
    expect(s.study_s).toBe(90 * 60)
    expect(s.manual_s).toBe(3600)
    expect(s.manual_by_category).toEqual({ meal: 3600 })
    expect(s.study_by_project).toEqual({ p1: 5400 })
    expect(s).toMatchObject({ kcal: 2150, protein_g: 160.5, carb_g: 210, fat_g: 70, sets_count: 12, volume: 7420, sessions_count: 1, routine_done: 1, routine_total: 2, bed_late_min: -10 })
    expect(s.final).toBe(1) // 2026-09-26 <= 2026-09-28 - 2
    expect(s.computed_at).toBe('2026-09-28T16:00:00.000Z')
  })
  it('food sums are null when nothing was logged, and a recent day is not final', () => {
    const r = buildDay(pastDay())
    const agg = parseAggregates([d1([{ n: 0, kcal: null, protein_g: null, carb_g: null, fat_g: null }]), d1([{ n: 0, volume: 0 }]), d1([{ n: 0 }])])
    const s = composeSummary(DAY, r, agg, { routine_done: 0, routine_total: 2, bed_late_min: null, today: '2026-09-27', nowIso: 'x' })
    expect(s.kcal).toBeNull()
    expect(s.protein_g).toBeNull()
    expect(s.final).toBe(0)
    expect(s.bed_late_min).toBeNull()
  })
  it('isFinalDay flips two days back', () => {
    expect(isFinalDay('2026-09-26', '2026-09-28')).toBe(true)
    expect(isFinalDay('2026-09-27', '2026-09-28')).toBe(false)
    expect(isFinalDay('2026-09-28', '2026-09-28')).toBe(false)
  })
})

describe('row <-> summary', () => {
  it('round-trips through the upsert parameters and the raw row shape', () => {
    const s = composeSummary(DAY, buildDay(pastDay()), parseAggregates([d1([{ n: 1, kcal: 500, protein_g: 1, carb_g: 2, fat_g: 3 }]), d1([{ n: 2, volume: 100 }]), d1([{ n: 1 }])]), {
      routine_done: 1, routine_total: 2, bed_late_min: 5, today: '2026-09-28', nowIso: '2026-09-28T16:00:00.000Z',
    })
    const params = summaryParams(s)
    expect(params).toHaveLength(SUMMARY_COLUMNS.length)
    const row: Record<string, unknown> = {}
    SUMMARY_COLUMNS.forEach((c, i) => { row[c] = params[i] })
    expect(typeof row['mac_by_category']).toBe('string')
    expect(rowToSummary(row)).toEqual(s)
  })
  it('tolerates malformed JSON maps and string numbers from D1', () => {
    const s = rowToSummary({ local_day: DAY, sleep_s: '100', mac_by_category: '{bad', study_by_project: '[1]', manual_by_category: '{"meal":"60"}', final: 1, computed_at: 'x' })
    expect(s.sleep_s).toBe(100)
    expect(s.mac_by_category).toEqual({})
    expect(s.study_by_project).toEqual({})
    expect(s.manual_by_category).toEqual({ meal: 60 })
    expect(s.final).toBe(1)
    expect(s.kcal).toBeNull()
  })
  it('the upsert SQL names every column and updates all but the key', () => {
    expect(SUMMARY_UPSERT_SQL).toContain('INSERT INTO day_summary (local_day, sleep_s')
    expect(SUMMARY_UPSERT_SQL).toContain('ON CONFLICT(local_day) DO UPDATE SET sleep_s = excluded.sleep_s')
    expect(SUMMARY_UPSERT_SQL).not.toContain('local_day = excluded.local_day')
    expect(SUMMARY_UPSERT_SQL).toContain('computed_at = excluded.computed_at')
    expect(AGGREGATE_SQL).toHaveLength(3)
  })
  it('emptySummary is a zero row with no computed_at', () => {
    expect(emptySummary('2026-01-01')).toMatchObject({ local_day: '2026-01-01', tracked_s: 0, unknown_s: 0, kcal: null, final: 0, computed_at: null })
  })
})

describe('/api/summary planning', () => {
  const summary = (day: string, final: number): DaySummary => ({ ...emptySummary(day), tracked_s: 86400, final, computed_at: 'x' })
  it('dayRange is inclusive and crosses month ends', () => {
    expect(dayRange('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'])
  })
  it('parseRange validates and caps at 62 days', () => {
    const now = new Date('2026-09-28T16:00:00Z')
    expect(parseRange('2026-09-01', 'today', now, TZ)).toEqual({ from: '2026-09-01', to: '2026-09-28' })
    expect(() => parseRange('2026-13-01', '2026-09-28', now, TZ)).toThrow(HttpError)
    expect(() => parseRange('2026-09-28', '2026-09-27', now, TZ)).toThrow(/from must not be after/)
    expect(() => parseRange('2026-07-01', '2026-08-31', now, TZ)).not.toThrow() // 62 days
    expect(() => parseRange('2026-07-01', '2026-09-01', now, TZ)).toThrow(/at most 62 days/)
    expect(() => parseRange(null, null, now, TZ)).toThrow(HttpError)
  })
  it('final rows pass through, today is live, the oldest 3 pending days recompute and the rest are stale', () => {
    const today = '2026-09-28'
    const days = dayRange('2026-09-20', '2026-09-30')
    const rows = new Map<string, DaySummary>([
      ['2026-09-20', summary('2026-09-20', 1)],
      ['2026-09-21', summary('2026-09-21', 0)], // non-final -> recompute
      ['2026-09-25', summary('2026-09-25', 1)],
      ['2026-09-27', summary('2026-09-27', 0)], // non-final beyond the cap, not dirty -> served as is
    ])
    const plan = planRange(days, rows, new Set(), today)
    expect(plan.live).toBe(today)
    expect(plan.final).toEqual(['2026-09-20', '2026-09-25'])
    expect(plan.recompute).toEqual(['2026-09-21', '2026-09-22', '2026-09-23'])
    expect(plan.stale).toEqual(['2026-09-24', '2026-09-26'])
    expect(plan.asIs).toEqual(['2026-09-27'])
    // future days never appear anywhere
    const all = [plan.live, ...plan.final, ...plan.recompute, ...plan.stale, ...plan.asIs]
    expect(all).not.toContain('2026-09-29')
    expect(all).not.toContain('2026-09-30')
  })
  it('a dirty day is rebuilt (or flagged) even when its row is final', () => {
    const today = '2026-09-28'
    const rows = new Map<string, DaySummary>([['2026-09-10', summary('2026-09-10', 1)], ['2026-09-27', summary('2026-09-27', 0)]])
    const plan = planRange(dayRange('2026-09-01', '2026-09-27'), rows, new Set(['2026-09-10', '2026-09-27']), today, 1)
    expect(plan.final).toEqual([])
    expect(plan.recompute).toEqual(['2026-09-01'])
    expect(plan.stale).toContain('2026-09-10')
    expect(plan.stale).toContain('2026-09-27')
    expect(plan.asIs).toEqual([])
  })
  it('a range that ends before today has no live day', () => {
    expect(planRange(['2026-09-01', '2026-09-02'], new Map(), new Set(), '2026-09-28').live).toBeNull()
  })
})

describe('cron', () => {
  it('rebuilds D-1, D-2 and then the dirty backlog oldest first, capped and never today', () => {
    const dirty = ['2026-09-27', '2026-09-01', '2026-09-28', '2026-09-10', '2026-09-05']
    expect(planRebuilds('2026-09-28', dirty)).toEqual(['2026-09-27', '2026-09-26', '2026-09-01', '2026-09-05', '2026-09-10'])
    const many = Array.from({ length: 30 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`)
    expect(planRebuilds('2026-09-28', many)).toHaveLength(2 + 5) // D-1, D-2 plus the dirty drain cap
    expect(planRebuilds('2026-09-28', [])).toEqual(['2026-09-27', '2026-09-26'])
  })
  it('auto-close statements only touch open rows and stamp ended_by auto', () => {
    expect(AUTO_CLOSE_WORKOUTS_SQL).toContain("ended_by = 'auto'")
    expect(AUTO_CLOSE_WORKOUTS_SQL).toContain('WHERE ended_at IS NULL AND deleted_at IS NULL AND started_at < ?')
    expect(AUTO_CLOSE_WORKOUTS_SQL).toContain("'+2 minutes'")
    expect(AUTO_CLOSE_WORKOUTS_SQL).toContain("'+3 hours'")
    expect(AUTO_CLOSE_SESSIONS_SQL).toContain('duration_s = 10800')
    expect(AUTO_CLOSE_SESSIONS_SQL).toContain('WHERE ended_at IS NULL AND deleted_at IS NULL AND started_at < ?')
  })
})

describe('write: days a row touches', () => {
  it('a night marks the bed day and the wake morning; a block past midnight marks both days', () => {
    expect(rowDays('sleep', { night_of: '2026-09-25', bed_ts: local('2026-09-25', '23:20') }, TZ).sort()).toEqual(['2026-09-25', '2026-09-26'])
    expect(rowDays('time_blocks', { start_ts: local('2026-09-25', '23:30'), end_ts: local('2026-09-26', '00:30') }, TZ).sort()).toEqual(['2026-09-25', '2026-09-26'])
    expect(rowDays('time_blocks', { start_ts: local('2026-09-25', '10:00'), end_ts: local('2026-09-25', '11:00') }, TZ)).toEqual(['2026-09-25'])
    expect(rowDays('sessions', { local_day: '2026-09-25', started_at: local('2026-09-25', '23:00'), ended_at: local('2026-09-26', '01:00') }, TZ).sort()).toEqual(['2026-09-25', '2026-09-26'])
    expect(rowDays('settings', { key: 'tz' }, TZ)).toEqual([])
    expect(rowDays('time_blocks', { start_ts: 'nope' }, TZ)).toEqual([])
  })
})

describe('export', () => {
  it('covers every table in schema.sql', () => {
    expect([...EXPORT_TABLES].sort()).toEqual([
      'app_categories', 'automation_health', 'checkins', 'day_summary', 'dirty_days', 'exercises', 'food_log', 'foods', 'meal_items', 'meals',
      'projects', 'routine_items', 'routine_log', 'screen_hours', 'screen_intervals', 'sessions', 'sets', 'settings', 'sleep', 'tap_log', 'time_blocks', 'workouts',
    ])
  })
})
