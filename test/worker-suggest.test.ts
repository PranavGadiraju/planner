import { describe, expect, it } from 'vitest'
import type { DayInput, ScreenHour, ScreenInterval } from '@shared/day'
import { dayWindow } from '@shared/tz'
import { suggestSessions } from '../src/worker/routes/work/suggest'

const TZ = 'America/New_York'
const DAY = '2026-09-28' // a Monday, EDT (-04:00)
const NEXT = new Date('2027-01-01T12:00:00Z') // a later "now": the whole day is in the past
const local = (hhmm: string, day = DAY, off = '-04:00') => new Date(`${day}T${hhmm}:00${off}`).toISOString()

const VSCODE = 'com.microsoft.VSCode'
const TERMINAL = 'com.apple.Terminal'
const SAFARI = 'com.apple.Safari'

const base = (now: Date = NEXT, day = DAY): DayInput => ({
  day, tz: TZ, now, time_blocks: [], sleep: [], workouts: [], sessions: [], routine_log: [], routine_items: [],
  screen_intervals: [], screen_hours: [],
  app_categories: [
    { app_id: VSCODE, label: 'VS Code', category: 'dev' },
    { app_id: TERMINAL, label: 'Terminal', category: 'dev' },
    { app_id: 'com.figma.Desktop', label: null, category: 'work' },
    { app_id: SAFARI, label: 'Safari', category: 'browsing' },
  ],
})
const iv = (start: string, end: string, app: string): ScreenInterval => ({ source: 'mac', device: 'mbp', start_ts: local(start), end_ts: local(end), top_app: app })
/** Hour rows for a block: seconds of `app` in each UTC hour it overlaps. */
function hoursFor(start: string, end: string, app: string, day = DAY): ScreenHour[] {
  const s = new Date(local(start, day)).getTime()
  const e = new Date(local(end, day)).getTime()
  const out: ScreenHour[] = []
  for (let h = Math.floor(s / 3600_000) * 3600_000; h < e; h += 3600_000) {
    const ov = Math.min(e, h + 3600_000) - Math.max(s, h)
    if (ov > 0) out.push({ source: 'mac', device: 'mbp', hour_start: new Date(h).toISOString(), app_id: app, seconds: ov / 1000 })
  }
  return out
}
const session = (start: string, end: string | null, extra: Partial<DayInput['sessions'][number]> = {}): DayInput['sessions'][number] => ({
  id: 's', project_id: 'p1', project_name: 'planner', started_at: local(start), ended_at: end ? local(end) : null, local_day: DAY,
  duration_s: null, note: null, source: 'app', ended_by: null, created_at: '', updated_at: '', deleted_at: null, ...extra,
})
const spans = (r: ReturnType<typeof suggestSessions>) => r.map((s) => [s.start, s.end, s.minutes])

describe('suggestSessions', () => {
  it('a 2 h VS Code block with a 30 min session in the middle yields the two free 45 min halves', () => {
    const inp = base()
    inp.screen_intervals = [iv('09:00', '11:00', VSCODE)]
    inp.screen_hours = hoursFor('09:00', '11:00', VSCODE)
    inp.sessions = [session('09:45', '10:15')]
    const r = suggestSessions(inp)
    expect(spans(r)).toEqual([
      [local('09:00'), local('09:45'), 45],
      [local('10:15'), local('11:00'), 45],
    ])
    expect(r[0]?.top_apps).toEqual([{ app_id: VSCODE, label: 'VS Code', minutes: 45 }])
    expect(r[1]?.top_apps).toEqual([{ app_id: VSCODE, label: 'VS Code', minutes: 45 }])
  })
  it('the whole block is one suggestion when nothing claims it, with exact edges', () => {
    const inp = base()
    inp.screen_intervals = [iv('09:10', '10:40', VSCODE)]
    inp.screen_hours = hoursFor('09:10', '10:40', VSCODE)
    expect(spans(suggestSessions(inp))).toEqual([[local('09:10'), local('10:40'), 90]])
  })
  it('Safari-only time yields nothing; an uncategorised app neither', () => {
    const inp = base()
    inp.screen_intervals = [iv('09:00', '12:00', SAFARI), iv('13:00', '15:00', 'com.unknown.App')]
    inp.screen_hours = [...hoursFor('09:00', '12:00', SAFARI), ...hoursFor('13:00', '15:00', 'com.unknown.App')]
    expect(suggestSessions(inp)).toEqual([])
  })
  it('a block interrupted by 10 min of browsing still qualifies as one range (25 of 30)', () => {
    const inp = base()
    inp.screen_intervals = [iv('09:00', '09:30', VSCODE), iv('09:30', '09:40', SAFARI), iv('09:40', '10:30', VSCODE)]
    inp.screen_hours = [...hoursFor('09:00', '09:30', VSCODE), ...hoursFor('09:30', '09:40', SAFARI), ...hoursFor('09:40', '10:30', VSCODE)]
    const r = suggestSessions(inp)
    expect(spans(r)).toEqual([[local('09:00'), local('10:30'), 90]])
    expect(r[0]?.top_apps).toEqual([{ app_id: VSCODE, label: 'VS Code', minutes: 80 }])
  })
  it('a 15 min interruption splits the block in two', () => {
    const inp = base()
    inp.screen_intervals = [iv('09:00', '09:30', VSCODE), iv('09:30', '09:45', SAFARI), iv('09:45', '10:30', VSCODE)]
    expect(spans(suggestSessions(inp))).toEqual([
      [local('09:00'), local('09:30'), 30],
      [local('09:45'), local('10:30'), 45],
    ])
  })
  it('nothing after now on today, and the suggestion ends at now', () => {
    const now = new Date(local('10:00'))
    const inp = base(now)
    inp.screen_intervals = [iv('09:00', '12:00', VSCODE)]
    inp.screen_hours = hoursFor('09:00', '12:00', VSCODE)
    expect(spans(suggestSessions(inp))).toEqual([[local('09:00'), local('10:00'), 60]])
    // too little of the day has passed for a single window
    expect(suggestSessions(base(new Date(local('00:20'))))).toEqual([])
    // a day in the future has nothing to suggest
    expect(suggestSessions(base(new Date(local('12:00', '2026-09-27'))))).toEqual([])
  })
  it('a running session, an open workout, a manual block and last night claim minutes; deleted rows do not', () => {
    const now = new Date(local('12:00'))
    const inp = base(now)
    inp.screen_intervals = [iv('06:00', '12:00', VSCODE)]
    inp.sleep = [{ night_of: '2026-09-27', bed_ts: local('23:00', '2026-09-27'), wake_ts: local('06:30'), bed_source: 'nfc', wake_source: 'routine', target_bed: '23:00', late_min: 0, updated_at: '', deleted_at: null }]
    inp.time_blocks = [{ id: 't', start_ts: local('07:00'), end_ts: local('07:30'), category: 'meal', label: 'Breakfast', project_id: null, source: 'app', created_at: '', updated_at: '', deleted_at: null }]
    inp.workouts = [{ id: 'w', name: 'Push', started_at: local('09:00'), ended_at: null, local_day: DAY, note: null, ended_by: null, created_at: '', updated_at: '', deleted_at: null }] // open: 09:00 -> now (< 3 h)
    inp.sessions = [session('08:00', '08:30', { id: 'gone', deleted_at: '2026-09-28T13:00:00.000Z' })]
    expect(spans(suggestSessions(inp))).toEqual([
      [local('06:30'), local('07:00'), 30],
      [local('07:30'), local('09:00'), 90],
    ])
    // the workout is auto-capped at 3 h in buildDay's rules; here it runs to now so nothing after 09:00 is free
    inp.workouts[0]!.ended_at = local('09:30')
    inp.sessions.push(session('11:00', null)) // running until now
    expect(spans(suggestSessions(inp))).toEqual([
      [local('06:30'), local('07:00'), 30],
      [local('07:30'), local('09:00'), 90],
      [local('09:30'), local('11:00'), 90],
    ])
  })
  it('screen_hours fill hours the intervals do not cover (dev apps only), from the hour start', () => {
    const inp = base()
    // 13:00-14:00 local = 17:00Z: 45 min VS Code + 15 min Safari, no interval rows
    inp.screen_hours = [
      { source: 'mac', device: 'mbp', hour_start: '2026-09-28T17:00:00.000Z', app_id: VSCODE, seconds: 2700 },
      { source: 'mac', device: 'mbp', hour_start: '2026-09-28T17:00:00.000Z', app_id: SAFARI, seconds: 900 },
    ]
    expect(spans(suggestSessions(inp))).toEqual([[local('13:00'), local('13:45'), 45]])
    // with an interval covering the hour the walk adds nothing, and non-dev interval minutes stay non-dev
    inp.screen_intervals = [iv('13:00', '13:20', SAFARI), iv('13:20', '14:00', VSCODE)]
    expect(spans(suggestSessions(inp))).toEqual([[local('13:20'), local('14:00'), 40]])
    // phone hours never count
    inp.screen_intervals = []
    inp.screen_hours = inp.screen_hours.map((h) => ({ ...h, source: 'phone' as const }))
    expect(suggestSessions(inp)).toEqual([])
  })
  it('lists the top 3 apps by minutes inside the range, labels falling back to the bundle name', () => {
    const inp = base()
    inp.screen_intervals = [iv('09:00', '10:00', VSCODE), iv('10:00', '10:20', TERMINAL), iv('10:20', '10:30', 'com.figma.Desktop'), iv('10:30', '10:35', VSCODE)]
    const r = suggestSessions(inp)
    expect(spans(r)).toEqual([[local('09:00'), local('10:35'), 95]])
    expect(r[0]?.top_apps).toEqual([
      { app_id: VSCODE, label: 'VS Code', minutes: 65 },
      { app_id: TERMINAL, label: 'Terminal', minutes: 20 },
      { app_id: 'com.figma.Desktop', label: 'Desktop', minutes: 10 },
    ])
  })
  it('honours the options: categories, window, need, minimum block', () => {
    const inp = base()
    inp.screen_intervals = [iv('09:00', '09:40', SAFARI), iv('10:00', '10:20', VSCODE)]
    expect(suggestSessions(inp)).toEqual([]) // 20 min of dev is under a 30 min window
    expect(spans(suggestSessions(inp, { categories: ['browsing'] }))).toEqual([[local('09:00'), local('09:40'), 40]])
    expect(spans(suggestSessions(inp, { windowMin: 20, needMin: 20, minBlockMin: 20 }))).toEqual([[local('10:00'), local('10:20'), 20]])
  })
  it('is deterministic and stays inside the day window on DST days', () => {
    for (const [day, off] of [['2026-03-08', '-05:00'], ['2026-11-01', '-04:00']] as const) {
      const inp = base(NEXT, day)
      const start = new Date(`${day}T09:00:00${off}`).toISOString()
      const end = new Date(`${day}T11:00:00${off}`).toISOString()
      inp.screen_intervals = [{ source: 'mac', device: 'mbp', start_ts: start, end_ts: end, top_app: VSCODE }]
      const a = suggestSessions(inp)
      const b = suggestSessions(inp)
      expect(a).toEqual(b)
      expect(a.length).toBe(1)
      expect(a[0]?.minutes).toBe(120)
      const win = dayWindow(day, TZ)
      expect(a[0]!.start >= win.start.toISOString() && a[0]!.end <= win.end.toISOString()).toBe(true)
    }
    // an interval crossing local midnight is clipped to the day
    const inp = base()
    inp.screen_intervals = [{ source: 'mac', device: 'mbp', start_ts: local('23:00'), end_ts: local('01:00', '2026-09-29'), top_app: VSCODE }]
    expect(spans(suggestSessions(inp))).toEqual([[local('23:00'), local('00:00', '2026-09-29'), 60]])
  })
})
