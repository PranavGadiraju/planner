// data/suggest.ts: the pure helpers (keys, labels, pruning, edited spans), the visible list minus hidden keys, and
// the accept path queuing a 'suggest' session row through data/work.ts and the outbox (in node: idb-keyval fails
// quietly, so nothing here touches storage or the network).
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import * as outbox from '../src/app/data/outbox'
import { settings, today } from '../src/app/data/store'
import { projects, sessionsDay, todaySessions } from '../src/app/data/work'
import {
  acceptSuggestion, appsLabel, dismissSuggestion, editedSpan, hidden, pruneDismissed, spanLabel, suggestState, suggestionKey, suggestionLabel,
  visibleSuggestions, type Suggestion, type SuggestionsPayload,
} from '../src/app/data/suggest'
import { pickableProjects } from '../src/app/components/SuggestionCard'

const TZ = 'America/New_York'
const DAY = '2026-09-28'
const local = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00-04:00`).toISOString()
const sug = (start: string, end: string, apps: [string, string, number][] = [['com.microsoft.VSCode', 'VS Code', 90]]): Suggestion => ({
  start: local(start), end: local(end), minutes: Math.round((new Date(local(end)).getTime() - new Date(local(start)).getTime()) / 60000),
  top_apps: apps.map(([app_id, label, minutes]) => ({ app_id, label, minutes })),
})
const payload = (suggestions: Suggestion[], last: string | null = 'p1'): SuggestionsPayload => ({
  day: DAY, suggestions, projects: [{ id: 'p1', name: 'planner', color: null }, { id: 'p2', name: 'Thesis', color: '#f97316' }], last_project_id: last,
})

describe('labels and keys', () => {
  it('formats the Today line: "Mac dev time 09:10–10:40 · 1h30 · VS Code, Terminal"', () => {
    const s = sug('09:10', '10:40', [['com.microsoft.VSCode', 'VS Code', 70], ['com.apple.Terminal', 'Terminal', 20]])
    expect(spanLabel(s, TZ)).toBe('09:10–10:40')
    expect(appsLabel(s)).toBe('VS Code, Terminal')
    expect(suggestionLabel(s, TZ)).toBe('Mac dev time 09:10–10:40 · 1h30 · VS Code, Terminal')
    expect(suggestionLabel({ ...s, minutes: 45, top_apps: [] }, TZ)).toBe('Mac dev time 09:10–10:40 · 45 min')
  })
  it('keys a suggestion by start|end', () => {
    expect(suggestionKey(sug('09:10', '10:40'))).toBe(`${local('09:10')}|${local('10:40')}`)
  })
  it('prunes dismissed keys older than a week and caps the list, newest kept', () => {
    const now = new Date('2026-09-28T18:30:00.000Z')
    const fresh = `${local('09:00')}|${local('10:00')}`
    const old = `${local('09:00', '2026-09-01')}|${local('10:00', '2026-09-01')}`
    expect(pruneDismissed([old, 'garbage', fresh], now)).toEqual([fresh])
    const many = Array.from({ length: 5 }, (_, i) => `${local(`0${i + 1}:00`)}|${local(`0${i + 1}:30`)}`)
    expect(pruneDismissed(many, now, 7, 2)).toEqual(many.slice(-2))
  })
  it('turns edited HH:MM times into an ISO span on the day, rolling a wrapped end to the next day', () => {
    expect(editedSpan(DAY, '09:15', '10:30', TZ)).toEqual({ start: local('09:15'), end: local('10:30') })
    expect(editedSpan(DAY, '23:30', '00:30', TZ)).toEqual({ start: local('23:30'), end: local('00:30', '2026-09-29') })
    expect(editedSpan(DAY, '9:15', '10:30', TZ)).toBeNull()
    expect(editedSpan(DAY, '09:15', '', TZ)).toBeNull()
  })
  it('offers the payload projects minus archived ones the Work tab knows, plus locally queued ones', () => {
    const p = payload([])
    const proj = (id: string, name: string, extra: Partial<{ archived_at: string | null; deleted_at: string | null }> = {}) => ({
      id, name, color: null, archived_at: null, deleted_at: null, ...extra,
    })
    expect(pickableProjects(p, []).map((x) => x.id)).toEqual(['p1', 'p2'])
    expect(pickableProjects(p, [proj('p2', 'Thesis', { archived_at: '2026-09-01T00:00:00Z' }), proj('p3', 'New')]).map((x) => x.id)).toEqual(['p1', 'p3'])
    // the default project stays pickable even when archived
    expect(pickableProjects(payload([], 'p2'), [proj('p2', 'Thesis', { archived_at: '2026-09-01T00:00:00Z' })]).map((x) => x.id)).toEqual(['p1', 'p2'])
  })
})

describe('visible list, dismiss and accept', () => {
  beforeEach(() => {
    today.value = null
    settings.value = { ...DEFAULT_SETTINGS, tz: TZ }
    projects.value = []
    todaySessions.value = []
    sessionsDay.value = DAY
    hidden.value = new Set()
    suggestState(DAY).value = { day: DAY, data: null, loading: false, error: null, fetchedAt: null, cached: false }
  })
  it("lists a day's suggestions minus the hidden keys", () => {
    const a = sug('09:10', '10:40')
    const b = sug('14:00', '15:00')
    expect(visibleSuggestions(DAY)).toEqual([])
    suggestState(DAY).value = { ...suggestState(DAY).value, data: payload([a, b]) }
    expect(visibleSuggestions(DAY).map((s) => s.start)).toEqual([a.start, b.start])
    dismissSuggestion(a)
    expect(visibleSuggestions(DAY).map((s) => s.start)).toEqual([b.start])
    expect(hidden.value.has(suggestionKey(a))).toBe(true)
  })
  it('accepting queues a finished session with source suggest on the project and hides the suggestion', async () => {
    const a = sug('09:10', '10:40')
    suggestState(DAY).value = { ...suggestState(DAY).value, data: payload([a]) }
    const rows: { table: string; row: Record<string, unknown> }[] = []
    const off = outbox.onEnqueue((table, row) => { rows.push({ table, row }) })
    try {
      const row = await acceptSuggestion(a, 'p2', '  wired the suggestions ')
      expect(rows.map((x) => x.table)).toEqual(['sessions'])
      expect(rows[0]?.row).toMatchObject({
        id: row.id, project_id: 'p2', started_at: a.start, ended_at: a.end, local_day: DAY, duration_s: 5400, note: 'wired the suggestions',
        source: 'suggest', ended_by: 'user', deleted_at: null,
      })
      expect(rows[0]?.row).not.toHaveProperty('project_name')
      expect(row.project_name).toBe('Thesis') // from the payload's project list, before the Work tab ever loaded
      expect(visibleSuggestions(DAY)).toEqual([])
      expect(todaySessions.value.map((s) => s.id)).toEqual([row.id]) // the optimistic mirror in data/work.ts
    } finally { off() }
  })
  it('accepting with edited times logs that span but hides the original suggestion', async () => {
    const a = sug('09:10', '10:40')
    suggestState(DAY).value = { ...suggestState(DAY).value, data: payload([a]) }
    const rows: Record<string, unknown>[] = []
    const off = outbox.onEnqueue((_t, row) => { rows.push(row) })
    try {
      const span = editedSpan(DAY, '09:15', '10:30', TZ)!
      const row = await acceptSuggestion(a, 'p1', undefined, span)
      expect(row).toMatchObject({ started_at: local('09:15'), ended_at: local('10:30'), duration_s: 4500, note: null, source: 'suggest' })
      expect(rows[0]).toMatchObject({ started_at: local('09:15'), ended_at: local('10:30') })
      expect(hidden.value.has(suggestionKey(a))).toBe(true)
      await expect(acceptSuggestion(a, 'p1', undefined, { start: local('10:00'), end: local('09:00') })).rejects.toThrow('End must be after start')
    } finally { off() }
  })
})
