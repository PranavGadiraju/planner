import { describe, expect, it } from 'vitest'
import { buildDay, type DayInput } from '@shared/day'
import { dayWindow } from '@shared/tz'

const TZ = 'America/New_York'
const local = (day: string, hhmm: string, off = '-04:00') => new Date(`${day}T${hhmm}:00${off}`).toISOString()
const base = (day: string, now: Date): DayInput => ({
  day, tz: TZ, now, time_blocks: [], sleep: [], workouts: [], sessions: [], routine_log: [],
  routine_items: [
    { id: 'shower', name: 'Shower', icon: null, position: 1, default_min: 15, chart_category: 'routine', active: 1, updated_at: '', deleted_at: null },
    { id: 'run', name: 'Morning run', icon: null, position: 2, default_min: 40, chart_category: 'workout', active: 1, updated_at: '', deleted_at: null },
  ],
  screen_intervals: [], screen_hours: [],
  app_categories: [{ app_id: 'com.microsoft.VSCode', label: 'VS Code', category: 'dev' }, { app_id: 'com.apple.Safari', label: 'Safari', category: 'browsing' }],
})
const sumBlocks = (r: ReturnType<typeof buildDay>) => r.blocks.reduce((a, b) => a + b.minutes, 0)
const sumTotals = (r: ReturnType<typeof buildDay>) => {
  const t = r.totals
  return t.sleep_s + t.workout_s + t.study_s + t.routine_s + t.mac_s + t.phone_s + t.manual_s + t.unknown_s
}
const DAY = '2026-09-28'
const NEXT = new Date('2027-01-01T12:00:00Z') // a later "now" so every tested day is in the past

describe('buildDay window and totals invariants', () => {
  it('a past day with nothing logged is 1440 minutes of Unknown', () => {
    const r = buildDay(base(DAY, NEXT))
    expect(r.minutes).toBe(1440)
    expect(sumBlocks(r)).toBe(1440)
    expect(r.totals.unknown_s).toBe(86400)
    expect(r.gaps.length).toBe(1)
  })
  it('DST days have 1380 / 1500 minutes and blocks still sum to N', () => {
    for (const [day, n] of [['2026-03-08', 1380], ['2026-11-01', 1500]] as const) {
      const r = buildDay(base(day, NEXT))
      expect(r.minutes).toBe(n)
      expect(sumBlocks(r)).toBe(n)
      expect(sumTotals(r)).toBe(n * 60)
      expect(dayWindow(day, TZ).minutes).toBe(n)
    }
  })
  it('today only counts minutes up to now', () => {
    const now = new Date(local(DAY, '10:30'))
    const r = buildDay(base(DAY, now))
    expect(r.is_today).toBe(true)
    expect(r.now_min).toBe(630)
    expect(sumBlocks(r)).toBe(630)
    expect(r.totals.tracked_s).toBe(630 * 60)
  })
})

describe('precedence', () => {
  it('a workout overlapping a running session wins and nothing is double counted', () => {
    const inp = base(DAY, NEXT)
    inp.sessions = [{ id: 's1', project_id: 'p1', project_name: 'planner', started_at: local(DAY, '10:00'), ended_at: local(DAY, '11:00'), local_day: DAY, duration_s: 3600, note: null, source: 'app', ended_by: 'user', created_at: '', updated_at: '', deleted_at: null }]
    inp.workouts = [{ id: 'w1', name: 'Push', started_at: local(DAY, '10:30'), ended_at: local(DAY, '11:30'), local_day: DAY, note: null, ended_by: 'user', created_at: '', updated_at: '', deleted_at: null }]
    const r = buildDay(inp)
    expect(r.totals.workout_s).toBe(3600)
    expect(r.totals.study_s).toBe(1800)
    const study = r.blocks.find((b) => b.category === 'study')!
    expect([study.start, study.end]).toEqual([local(DAY, '10:00'), local(DAY, '10:30')])
    expect(r.study_by_project.p1).toBe(3600) // raw seconds, not tinted cells
  })
  it('manual blocks beat everything, sleep beats mac', () => {
    const inp = base(DAY, NEXT)
    inp.sleep = [{ night_of: '2026-09-27', bed_ts: local('2026-09-27', '23:20'), wake_ts: local(DAY, '06:52'), bed_source: 'nfc', wake_source: 'routine', target_bed: '23:00', late_min: 20, updated_at: '', deleted_at: null }]
    inp.screen_intervals = [{ source: 'mac', device: 'mbp', start_ts: local(DAY, '06:00'), end_ts: local(DAY, '08:00'), top_app: 'com.microsoft.VSCode' }]
    inp.time_blocks = [{ id: 't1', start_ts: local(DAY, '07:00'), end_ts: local(DAY, '07:30'), category: 'meal', label: 'Breakfast', project_id: null, source: 'app', created_at: '', updated_at: '', deleted_at: null }]
    const r = buildDay(inp)
    expect(r.totals.sleep_s).toBe((6 * 60 + 52) * 60)
    expect(r.totals.manual_s).toBe(1800)
    expect(r.manual_by_category.meal).toBe(1800)
    expect(r.totals.mac_s).toBe(60 * 60 + 8 * 60 - 1800) // 06:52-08:00 minus the meal block
    const mac = r.blocks.filter((b) => b.category === 'mac')
    expect(mac[0]?.sub).toBe('dev')
    expect(mac[0]?.label).toBe('VS Code')
  })
  it('routine taps use real duration when finished and the default when not', () => {
    const inp = base(DAY, NEXT)
    inp.routine_log = [
      { local_day: DAY, item_id: 'run', started_at: local(DAY, '06:55'), ended_at: local(DAY, '07:36'), source: 'nfc', updated_at: '', deleted_at: null },
      { local_day: DAY, item_id: 'shower', started_at: local(DAY, '07:40'), ended_at: null, source: 'nfc', updated_at: '', deleted_at: null },
    ]
    const r = buildDay(inp)
    expect(r.totals.workout_s).toBe(41 * 60) // run counts as workout
    expect(r.totals.routine_s).toBe(15 * 60)
  })
})

describe('screen time placement', () => {
  it('mac hour totals fill from the hour start only into unknown minutes; phone takes what is left', () => {
    const inp = base(DAY, NEXT)
    const hour = new Date(local(DAY, '13:00')).toISOString()
    inp.sessions = [{ id: 's', project_id: 'p', project_name: 'x', started_at: local(DAY, '13:00'), ended_at: local(DAY, '13:30'), local_day: DAY, duration_s: 1800, note: null, source: 'app', ended_by: 'user', created_at: '', updated_at: '', deleted_at: null }]
    inp.screen_hours = [
      { source: 'mac', device: 'mbp', hour_start: hour, app_id: 'com.microsoft.VSCode', seconds: 45 * 60 },
      { source: 'mac', device: 'mbp', hour_start: hour, app_id: 'com.apple.Safari', seconds: 20 * 60 },
      { source: 'phone', device: 'iPhone', hour_start: hour, app_id: '_total', seconds: 20 * 60 },
    ]
    const r = buildDay(inp)
    expect(r.totals.study_s).toBe(1800)
    expect(r.totals.mac_s).toBe(30 * 60) // 60 wanted, only 30 left in the hour
    expect(r.totals.phone_s).toBe(0) // nothing left for the phone
    expect(r.mac_by_category).toEqual({ dev: 2700, browsing: 1200 }) // raw seconds
  })
  it('intervals are not double counted by the hour walk', () => {
    const inp = base(DAY, NEXT)
    const hour = new Date(local(DAY, '13:00')).toISOString()
    inp.screen_intervals = [{ source: 'mac', device: 'mbp', start_ts: local(DAY, '13:10'), end_ts: local(DAY, '13:40'), top_app: 'com.apple.Safari' }]
    inp.screen_hours = [{ source: 'mac', device: 'mbp', hour_start: hour, app_id: 'com.apple.Safari', seconds: 30 * 60 }]
    const r = buildDay(inp)
    expect(r.totals.mac_s).toBe(1800)
    expect(r.blocks.find((b) => b.category === 'mac')?.start).toBe(local(DAY, '13:10'))
  })
})

describe('study block apps', () => {
  const session = (id: string, s: string, e: string): DayInput['sessions'][number] => ({
    id, project_id: 'p1', project_name: 'planner', started_at: s, ended_at: e, local_day: DAY, duration_s: 0, note: null, source: 'app', ended_by: 'user', created_at: '', updated_at: '', deleted_at: null,
  })
  const mac = (hour_start: string, app_id: string, seconds: number): DayInput['screen_hours'][number] => ({ source: 'mac', device: 'mbp', hour_start, app_id, seconds })
  const hour13 = new Date(local(DAY, '13:00')).toISOString()
  const study = (r: ReturnType<typeof buildDay>) => r.blocks.filter((b) => b.category === 'study')

  it('pro-rates the hour rows by the share of the hour the block covers and keeps the top 3 by seconds', () => {
    const inp = base(DAY, NEXT)
    inp.sessions = [session('s', local(DAY, '13:00'), local(DAY, '13:30'))]
    inp.screen_hours = [
      mac(hour13, 'com.microsoft.VSCode', 2700), mac(hour13, 'com.apple.Safari', 1200), mac(hour13, 'com.apple.Terminal', 600), mac(hour13, 'com.apple.Music', 60),
      { source: 'phone', device: 'iPhone', hour_start: hour13, app_id: '_total', seconds: 1800 }, // phone rows are never Mac apps
    ]
    const r = buildDay(inp)
    expect(study(r)[0]?.apps).toEqual([{ label: 'VS Code', seconds: 1350 }, { label: 'Safari', seconds: 600 }, { label: 'Terminal', seconds: 300 }])
    expect(r.blocks.filter((b) => b.category !== 'study').every((b) => b.apps === undefined)).toBe(true)
    expect(r.totals.study_s).toBe(1800) // the chart is untouched: the session still owns its minutes
  })
  it('a block over two hours takes each hour by its own share; an hour without rows falls back to the focus intervals', () => {
    const inp = base(DAY, NEXT)
    inp.sessions = [session('s', local(DAY, '13:30'), local(DAY, '14:45'))]
    inp.screen_hours = [mac(hour13, 'com.microsoft.VSCode', 3600)]
    inp.screen_intervals = [
      // hour 13 has rows, so this interval only counts for its 14:00-14:10 tail
      { source: 'mac', device: 'mbp', start_ts: local(DAY, '13:00'), end_ts: local(DAY, '14:10'), top_app: 'com.microsoft.VSCode' },
      { source: 'mac', device: 'mbp', start_ts: local(DAY, '14:20'), end_ts: local(DAY, '15:00'), top_app: 'com.apple.Safari' },
    ]
    const r = buildDay(inp)
    // hour 13: 3600 x 30/60 = 1800 VS Code; hour 14 from intervals: 600 VS Code + 1500 Safari (clipped at 14:45)
    expect(study(r)[0]?.apps).toEqual([{ label: 'VS Code', seconds: 2400 }, { label: 'Safari', seconds: 1500 }])
  })
  it('apps are attached after the run-length merge, so adjacent sessions stay one block and share one list', () => {
    const inp = base(DAY, NEXT)
    inp.sessions = [session('a', local(DAY, '13:00'), local(DAY, '13:30')), session('b', local(DAY, '13:30'), local(DAY, '14:00'))]
    inp.screen_hours = [mac(hour13, 'com.apple.Safari', 1200)]
    const r = buildDay(inp)
    expect(study(r).length).toBe(1)
    expect(study(r)[0]?.apps).toEqual([{ label: 'Safari', seconds: 1200 }])
    expect(sumBlocks(r)).toBe(1440)
  })
  it('a manual study block gets apps too; without Mac data inside it the field is absent', () => {
    const inp = base(DAY, NEXT)
    inp.time_blocks = [{ id: 't', start_ts: local(DAY, '13:00'), end_ts: local(DAY, '13:30'), category: 'study', label: 'Reading', project_id: null, source: 'app', created_at: '', updated_at: '', deleted_at: null }]
    expect(study(buildDay(inp))[0]?.apps).toBeUndefined()
    inp.screen_intervals = [{ source: 'mac', device: 'mbp', start_ts: local(DAY, '13:10'), end_ts: local(DAY, '13:40'), top_app: 'com.unknown.app' }]
    expect(study(buildDay(inp))[0]?.apps).toEqual([{ label: 'app', seconds: 1200 }]) // unlabelled bundle -> short name
    inp.screen_hours = [{ source: 'mac', device: 'mbp', hour_start: hour13.replace('.000Z', 'Z'), app_id: 'com.apple.Safari', seconds: 3600 }]
    expect(study(buildDay(inp))[0]?.apps).toEqual([{ label: 'Safari', seconds: 1800 }]) // rows beat intervals, hour key matched by instant
  })
})

describe('display', () => {
  it('unknown runs under 5 minutes are absorbed for display but still counted as unknown', () => {
    const inp = base(DAY, NEXT)
    inp.sessions = [
      { id: 'a', project_id: 'p', project_name: 'x', started_at: local(DAY, '09:00'), ended_at: local(DAY, '09:30'), local_day: DAY, duration_s: 1800, note: null, source: 'app', ended_by: 'user', created_at: '', updated_at: '', deleted_at: null },
      { id: 'b', project_id: 'p', project_name: 'x', started_at: local(DAY, '09:33'), ended_at: local(DAY, '10:00'), local_day: DAY, duration_s: 1620, note: null, source: 'app', ended_by: 'user', created_at: '', updated_at: '', deleted_at: null },
    ]
    const r = buildDay(inp)
    const study = r.blocks.filter((b) => b.category === 'study')
    expect(study.length).toBe(1)
    expect(study[0]?.minutes).toBe(60)
    expect(r.totals.study_s).toBe(57 * 60)
    expect(r.totals.unknown_s).toBe(86400 - 57 * 60)
    expect(r.gaps.length).toBe(2) // before 09:00 and after 10:00
  })
  it('an open sleep row older than 14 h is drawn as an 8 h guess and flagged', () => {
    const inp = base(DAY, NEXT)
    inp.sleep = [{ night_of: '2026-09-27', bed_ts: local('2026-09-27', '23:00'), wake_ts: null, bed_source: 'nfc', wake_source: null, target_bed: '23:00', late_min: 0, updated_at: '', deleted_at: null }]
    const r = buildDay(inp)
    expect(r.sleep_inferred).toBe(true)
    expect(r.totals.sleep_s).toBe(7 * 3600) // 00:00-07:00 of this day
    expect(r.blocks[0]?.label).toBe('Sleep?')
  })
})
