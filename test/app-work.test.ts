import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, TodayPayload } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import * as outbox from '../src/app/data/outbox'
import { today } from '../src/app/data/store'
import {
  addManualSession, checkinSummary, clockLabel, desiredRunning, durationSeconds, elapsedDays, endSession, groupByWeek, handleReject, projects, running,
  secondsLabel, sessionsDay, spanFor, startSession, todaySessions, weekBars, workoutNames, type SessionRow,
} from '../src/app/data/work'
import { parseHash } from '../src/app/router'

const TZ = 'America/New_York'
const DAY = '2026-09-28'
const NOW = new Date('2026-09-28T18:30:00.000Z') // 14:30 EDT

const project = (id: string, name: string, extra: Partial<Project> = {}): Project => ({
  id, name, kind: 'project', color: null, position: 1, archived_at: null, created_at: '', updated_at: '', deleted_at: null, ...extra,
})
const sess = (id: string, projectId: string, start: string, end: string | null, note: string | null = null, extra: Partial<SessionRow> = {}): SessionRow => ({
  id, project_id: projectId, started_at: start, ended_at: end, local_day: DAY, duration_s: end ? durationSeconds(start, end) : null, note,
  source: 'app', ended_by: end ? 'user' : null, created_at: start, updated_at: start, deleted_at: null, project_name: projectId, ...extra,
})
function payload(session: SessionRow | null): TodayPayload {
  return {
    today: DAY, now: NOW.toISOString(), tz: TZ, settings: DEFAULT_SETTINGS,
    routine_items: [
      { id: 'shower', name: 'Shower', icon: null, position: 1, default_min: 15, chart_category: 'routine', active: 1, updated_at: '', deleted_at: null },
      { id: 'run', name: 'Run', icon: null, position: 2, default_min: 40, chart_category: 'workout', active: 1, updated_at: '', deleted_at: null },
      { id: 'journal', name: 'Journal', icon: null, position: 3, default_min: 10, chart_category: 'routine', active: 1, updated_at: '', deleted_at: null },
    ],
    routine_log: [
      { local_day: DAY, item_id: 'shower', started_at: '2026-09-28T10:55:00.000Z', ended_at: '2026-09-28T11:10:00.000Z', source: 'nfc', updated_at: '', deleted_at: null },
      { local_day: DAY, item_id: 'run', started_at: '2026-09-28T11:15:00.000Z', ended_at: null, source: 'nfc', updated_at: '', deleted_at: null }, // 3 h ago: done by default length
    ],
    sleep: { tonight: null, last_night: null, streak: 0, open: null },
    checkin: null,
    running: { workout: null, session },
    health: { rows: [], taps_today: 0, mac_last_hour: null, phone_last_hour: null, apps_to_triage: 0 },
  }
}

describe('duration math', () => {
  it('computes whole seconds, never negative, and formats them', () => {
    expect(durationSeconds('2026-09-28T13:00:00.000Z', '2026-09-28T14:30:00.000Z')).toBe(5400)
    expect(durationSeconds('2026-09-28T14:30:00.000Z', '2026-09-28T13:00:00.000Z')).toBe(0)
    expect(secondsLabel(5400)).toBe('1h30')
    expect(secondsLabel(45 * 60)).toBe('45 min')
    expect(clockLabel(754)).toBe('12:34')
    expect(clockLabel(3920)).toBe('1:05:20')
    expect(clockLabel(0)).toBe('0:00')
  })
  it('spanFor mirrors the Worker: minutes alone ends now, start/end wraps past midnight, never before local midnight', () => {
    expect(spanFor({ minutes: 90 }, DAY, TZ, NOW)).toEqual({ started_at: '2026-09-28T17:00:00.000Z', ended_at: '2026-09-28T18:30:00.000Z', duration_s: 5400, local_day: DAY })
    const wrapped = spanFor({ start: new Date('2026-09-29T03:30:00.000Z'), end: new Date('2026-09-29T00:15:00.000Z') }, DAY, TZ, NOW)
    expect(wrapped.ended_at).toBe('2026-09-30T00:15:00.000Z')
    const early = spanFor({ minutes: 90 }, DAY, TZ, new Date('2026-09-28T04:30:00.000Z')) // 00:30 local
    expect(early.started_at).toBe('2026-09-28T04:00:00.000Z')
    expect(early.local_day).toBe(DAY)
    const past = spanFor({ minutes: 30 }, '2026-09-25', TZ, NOW)
    expect(past).toMatchObject({ ended_at: '2026-09-25T18:30:00.000Z', local_day: '2026-09-25' })
    expect(spanFor({ start: new Date('2026-09-28T13:00:00.000Z'), minutes: 25 }, DAY, TZ, NOW).ended_at).toBe('2026-09-28T13:25:00.000Z')
    expect(() => spanFor({}, DAY, TZ, NOW)).toThrow()
    expect(() => spanFor({ minutes: 0 }, DAY, TZ, NOW)).toThrow()
    expect(() => spanFor({ minutes: 2000 }, DAY, TZ, NOW)).toThrow()
  })
})

describe('week grouping', () => {
  it('groups changelog entries by Mon-Sun week, newest week first, keeping order inside', () => {
    const entries = [
      { id: 'a', local_day: '2026-09-28', duration_s: 3600, note: 'x' },
      { id: 'b', local_day: '2026-09-27', duration_s: 600, note: 'y' }, // Sunday: last week
      { id: 'c', local_day: '2026-09-22', duration_s: 1200, note: 'z' },
      { id: 'd', local_day: '2026-09-14', duration_s: null, note: null },
    ]
    const g = groupByWeek(entries)
    expect(g.map((w) => w.week_start)).toEqual(['2026-09-28', '2026-09-21', '2026-09-14'])
    expect(g[0]?.entries.map((e) => e.id)).toEqual(['a'])
    expect(g[1]?.entries.map((e) => e.id)).toEqual(['b', 'c'])
    expect(g[1]?.seconds).toBe(1800)
    expect(g[2]?.seconds).toBe(0)
    expect(groupByWeek([])).toEqual([])
  })
  it('turns the week payload into per-project bars, largest first', () => {
    const day = (d: string, by: Record<string, number>) => ({ local_day: d, seconds: Object.values(by).reduce((a, b) => a + b, 0), by_project: by })
    const bars = weekBars({
      days: [day('2026-09-28', { p1: 3600, p2: 600 }), day('2026-09-29', { p2: 6000 })],
      last_week: { week_start: '2026-09-21', days: [day('2026-09-21', { p1: 7200, p3: 100 })] },
      projects: [{ id: 'p1', name: 'Planner', kind: 'project', color: '#111', position: 1, archived_at: null }, { id: 'p2', name: 'Thesis', kind: 'study', color: null, position: 2, archived_at: null }],
    })
    expect(bars.map((b) => [b.name, b.this_week, b.last_week])).toEqual([['Thesis', 6600, 0], ['Planner', 3600, 7200], ['Session', 0, 100]])
    expect(bars[1]?.color).toBe('#111')
    expect(elapsedDays('2026-09-28', '2026-09-30')).toBe(3)
    expect(elapsedDays('2026-09-28', '2026-10-05')).toBe(7)
    expect(elapsedDays('2026-09-28', '2026-09-27')).toBe(0)
  })
})

describe('running session', () => {
  beforeEach(() => {
    today.value = null
    todaySessions.value = []
    sessionsDay.value = DAY // the list is keyed to a day; pin it so the test does not depend on the real clock
  })
  it('refuses to start a second session while one is running', async () => {
    const run = sess('s1', 'p1', '2026-09-28T17:00:00.000Z', null, null, { project_name: 'Planner' })
    today.value = payload(run)
    expect(running.value?.id).toBe('s1')
    const r = await startSession(project('p2', 'Thesis'))
    expect(r).toEqual({ ok: false, running: run })
    expect(running.value?.id).toBe('s1')
  })
  it('starts when nothing runs, mirrors into today.value, and ending clears it with the note and duration', async () => {
    today.value = payload(null)
    const r = await startSession(project('p1', 'Planner'), new Date('2026-09-28T17:00:00.000Z'))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.session).toMatchObject({ project_id: 'p1', project_name: 'Planner', ended_at: null, local_day: DAY, source: 'app' })
    expect(today.value?.running.session?.id).toBe(r.session.id)
    expect(running.value?.id).toBe(r.session.id)
    expect(todaySessions.value.map((s) => s.id)).toEqual([r.session.id])
    // a second start is refused with the running one
    const again = await startSession(project('p2', 'Thesis'))
    expect(again.ok).toBe(false)
    const ended = await endSession(r.session, '  built the sync layer ', new Date('2026-09-28T18:30:00.000Z'))
    expect(ended).toMatchObject({ id: r.session.id, ended_at: '2026-09-28T18:30:00.000Z', duration_s: 5400, note: 'built the sync layer', ended_by: 'user' })
    expect(running.value).toBeNull()
    expect(today.value?.running.session).toBeNull()
    expect(todaySessions.value[0]?.duration_s).toBe(5400)
  })
  it('ending with a project change sends one row carrying the new project, stamped after the start', async () => {
    projects.value = [project('p1', 'Planner'), project('p2', 'Thesis', { position: 2 })]
    today.value = payload(null)
    const rows: { table: string; row: Record<string, unknown> }[] = []
    const off = outbox.onEnqueue((table, row) => { rows.push({ table, row }) })
    try {
      const r = await startSession(project('p1', 'Planner'), new Date('2026-09-28T17:00:00.000Z'))
      if (!r.ok) throw new Error('unreachable')
      const ended = await endSession(r.session, ' moved it ', new Date('2026-09-28T18:00:00.000Z'), { project_id: 'p2' })
      // the end sheet used to queue an edit row and then an end row: with one updated_at the server kept only the first
      expect(rows.map((x) => x.table)).toEqual(['sessions', 'sessions'])
      expect(rows[1]?.row).toMatchObject({ id: r.session.id, project_id: 'p2', ended_at: '2026-09-28T18:00:00.000Z', duration_s: 3600, note: 'moved it', ended_by: 'user' })
      expect(rows[1]?.row).not.toHaveProperty('project_name')
      expect(ended.project_name).toBe('Thesis')
      expect(ended.updated_at > r.session.updated_at).toBe(true)
      expect(running.value).toBeNull()
      expect(todaySessions.value.map((s) => [s.id, s.project_id])).toEqual([[r.session.id, 'p2']])
    } finally { off() }
  })
  it('never gives two writes the same updated_at, even inside one millisecond', async () => {
    const frozen = vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-09-28T18:30:00.000Z').getTime())
    try {
      today.value = payload(null)
      const r = await startSession(project('p1', 'Planner'), new Date('2026-09-28T17:00:00.000Z'))
      if (!r.ok) throw new Error('unreachable')
      const ended = await endSession(r.session, '', new Date('2026-09-28T18:00:00.000Z'))
      expect(ended.updated_at > r.session.updated_at).toBe(true)
      const manual = await addManualSession(project('p1', 'Planner'), { minutes: 10 })
      expect(manual.updated_at > ended.updated_at).toBe(true)
    } finally { frozen.mockRestore() }
  })
  it('a start the server rejects stops running and leaves the list (other tables and unknown ids are ignored)', async () => {
    today.value = payload(null)
    const r = await startSession(project('p1', 'Planner'), new Date('2026-09-28T17:00:00.000Z'))
    if (!r.ok) throw new Error('unreachable')
    expect(running.value?.id).toBe(r.session.id)
    handleReject('projects', r.session.id) // another table's row: nothing changes here
    handleReject('time_blocks', r.session.id)
    expect(running.value?.id).toBe(r.session.id)
    handleReject('sessions', r.session.id)
    expect(running.value).toBeNull()
    expect(today.value?.running.session).toBeNull()
    expect(todaySessions.value).toEqual([])
    handleReject('sessions', r.session.id) // already gone: a no-op
    expect(todaySessions.value).toEqual([])
  })
  it('a buried batch ("N rows") drops every pending session, also the local stand-in before Today loads', async () => {
    today.value = null
    const r = await startSession(project('p1', 'Planner'), new Date('2026-09-28T17:00:00.000Z'))
    if (!r.ok) throw new Error('unreachable')
    const manual = await addManualSession(project('p1', 'Planner'), { minutes: 10, day: DAY }) // the list is pinned to DAY
    expect(running.value?.id).toBe(r.session.id)
    expect(todaySessions.value.map((s) => s.id).sort()).toEqual([r.session.id, manual.id].sort())
    handleReject('sessions', '2 rows')
    expect(running.value).toBeNull()
    expect(todaySessions.value).toEqual([])
  })
  it('desiredRunning lets queued rows override the server answer, newest first', () => {
    const server = sess('s1', 'p1', '2026-09-28T17:00:00.000Z', null)
    expect(desiredRunning(server, [])?.id).toBe('s1')
    const endedS1 = { ...server, ended_at: '2026-09-28T18:00:00.000Z', duration_s: 3600, updated_at: '2026-09-28T18:00:00.000Z' }
    expect(desiredRunning(server, [endedS1])).toBeNull()
    const s2 = sess('s2', 'p2', '2026-09-28T18:05:00.000Z', null, null, { updated_at: '2026-09-28T18:05:00.000Z' })
    expect(desiredRunning(server, [s2, endedS1])?.id).toBe('s2')
    expect(desiredRunning(null, [endedS1])).toBeNull()
    const deleted = { ...s2, deleted_at: '2026-09-28T18:06:00.000Z', updated_at: '2026-09-28T18:06:00.000Z' }
    expect(desiredRunning(null, [s2, deleted])).toBeNull()
  })
})

describe('evening check-in pre-fill', () => {
  it('lists projects with hours and notes, workouts, and the routine tally on one line', () => {
    const p = payload(sess('s3', 'p1', '2026-09-28T17:30:00.000Z', null, null, { project_name: 'planner' }))
    const sessions = [
      sess('s1', 'p1', '2026-09-28T13:00:00.000Z', '2026-09-28T14:00:00.000Z', 'built the sync layer', { project_name: 'planner' }),
      sess('s2', 'p2', '2026-09-28T15:00:00.000Z', '2026-09-28T15:20:00.000Z', null, { project_name: 'thesis' }),
      sess('s3', 'p1', '2026-09-28T17:30:00.000Z', null, null, { project_name: 'planner' }), // running: 1 h so far at NOW
    ]
    expect(checkinSummary(p, sessions, ['Push'], DAY, NOW)).toBe('planner 2h00 (built the sync layer) · thesis 20 min · Push workout · routine 2/3')
  })
  it('handles an empty day and does not double "workout"', () => {
    const p = payload(null)
    expect(checkinSummary(p, [], [], DAY, NOW)).toBe('routine 2/3')
    expect(checkinSummary({ ...p, routine_items: [], running: { workout: { name: 'Leg workout' }, session: null } }, [], [], DAY, NOW)).toBe('Leg workout')
    expect(checkinSummary({ ...p, routine_items: [] }, [], ['Push', 'Push'], DAY, NOW)).toBe('Push workout')
  })
  it('picks workout names from the day chart blocks, ignoring routine runs', () => {
    expect(workoutNames([
      { category: 'workout', source: 'workout', label: 'Push' },
      { category: 'workout', source: 'routine', label: 'Morning run' },
      { category: 'workout', source: 'workout', label: 'Push' },
      { category: 'study', source: 'session', label: 'planner' },
    ])).toEqual(['Push'])
  })
})

describe('work routes', () => {
  it('owns #/work and its sub-segments', () => {
    expect(parseHash('#/work')).toEqual({ name: 'work', rest: [] })
    expect(parseHash('#/work/start')).toEqual({ name: 'work', rest: ['start'] })
    expect(parseHash('#/work/p/abc-123')).toEqual({ name: 'work', rest: ['p', 'abc-123'] })
  })
})
