// The outbox path end to end: a session row the server rejects (a project it does not know yet, a validation
// failure, a buried 4xx batch) leaves the queue, stops being the running session and is not replayed over the next
// server answers. IndexedDB and the API client are replaced in memory; nothing here touches the network.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, TodayPayload, WriteRequest, WriteResponse } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { localDay } from '@shared/tz'

const mocks = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  apiPost: vi.fn<(path: string, body: unknown) => Promise<unknown>>(),
  apiGet: vi.fn<(path: string, key: string) => Promise<{ data: unknown; cached: boolean; fetchedAt: string }>>(),
}))
vi.mock('idb-keyval', () => ({
  get: async (k: string) => mocks.store.get(k),
  set: async (k: string, v: unknown) => { mocks.store.set(k, v) },
  del: async (k: string) => { mocks.store.delete(k) },
  clear: async () => { mocks.store.clear() },
  entries: async () => [...mocks.store.entries()],
}))
vi.mock('../src/app/data/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/app/data/api')>()
  return { ...mod, hasToken: () => true, apiPost: mocks.apiPost, apiGet: mocks.apiGet }
})

import { ApiError } from '../src/app/data/api'
import * as outbox from '../src/app/data/outbox'
import { today } from '../src/app/data/store'
import { addProject, loadTodaySessions, projects, running, sessionsDay, startSession, todaySessions } from '../src/app/data/work'

const TZ = 'America/New_York'

function payload(): TodayPayload {
  const now = new Date()
  return {
    today: localDay(now, TZ), now: now.toISOString(), tz: TZ, settings: { ...DEFAULT_SETTINGS, tz: TZ },
    routine_items: [], routine_log: [], sleep: { tonight: null, last_night: null, streak: 0, open: null }, checkin: null,
    running: { workout: null, session: null },
    health: { rows: [], taps_today: 0, mac_last_hour: null, phone_last_hour: null, apps_to_triage: 0 },
  }
}
const project = (id: string, name: string): Project => ({
  id, name, kind: 'project', color: null, position: 1, archived_at: null, created_at: '', updated_at: '', deleted_at: null,
})
/** The server after the rejection: it holds no session and no project. */
function serverAnswers(): void {
  mocks.apiGet.mockImplementation(async (path) => {
    const fetchedAt = new Date().toISOString()
    if (path === '/api/today') return { data: payload(), cached: false, fetchedAt }
    if (path.startsWith('/api/sessions')) return { data: { from: '', to: '', sessions: [], by_project: {}, by_day: {} }, cached: false, fetchedAt }
    if (path.startsWith('/api/work/week')) return { data: { day: '', week_start: '', days: [], last_week: { week_start: '', days: [] }, projects: [] }, cached: false, fetchedAt }
    if (path === '/api/projects') return { data: { projects: [] }, cached: false, fetchedAt }
    throw new Error(`unexpected GET ${path}`)
  })
}
/** POST /api/write answering 200 with every row rejected (what D1's FK check yields for an unknown project). */
function rejectEveryRow(reason: string): void {
  mocks.apiPost.mockImplementation(async (_path, body) => {
    const req = body as WriteRequest
    const rejected = req.mutations.flatMap((m) => m.rows.map((r) => ({ table: m.table, key: String(r['id']), reason })))
    const res: WriteResponse = { applied: 0, rejected }
    return res
  })
}
const flushed = async (): Promise<void> => {
  await outbox.flush()
  await vi.waitFor(() => { expect(outbox.status.value).toBe('idle') })
}

describe('rejected session rows', () => {
  beforeEach(async () => {
    mocks.store.clear()
    mocks.apiPost.mockReset()
    mocks.apiGet.mockReset()
    serverAnswers()
    await outbox.clearQueue()
    today.value = payload()
    todaySessions.value = []
    sessionsDay.value = null
    projects.value = []
  })

  it('a start the server refuses (FK) leaves the queue, stops running and is not replayed over the next answer', async () => {
    rejectEveryRow('FOREIGN KEY constraint failed')
    const r = await startSession(project('p-new', 'Brand new'))
    if (!r.ok) throw new Error('unreachable')
    expect(running.value?.id).toBe(r.session.id)
    expect(today.value?.running.session?.id).toBe(r.session.id)
    expect(todaySessions.value.map((s) => s.id)).toEqual([r.session.id])

    await flushed()
    expect(mocks.apiPost).toHaveBeenCalledTimes(1)
    const sent = mocks.apiPost.mock.calls[0]?.[1] as WriteRequest
    expect(sent.mutations).toEqual([{ table: 'sessions', rows: [expect.objectContaining({ id: r.session.id, project_id: 'p-new' })] }])
    expect(outbox.pending.value).toBe(0)
    expect(await outbox.peek()).toEqual([])
    // gone at once, before any reload answers
    expect(running.value).toBeNull()
    expect(today.value?.running.session).toBeNull()
    // and the reloads bring server truth: Today refreshed, no session today
    await vi.waitFor(() => {
      expect(mocks.apiGet).toHaveBeenCalledWith('/api/today', 'today')
      expect(mocks.apiGet.mock.calls.some(([p]) => p.startsWith('/api/sessions'))).toBe(true)
    })
    await loadTodaySessions()
    expect(todaySessions.value).toEqual([])
    expect(running.value).toBeNull()
  })

  it('a buried batch (permanent 4xx) is handled the same way through the outbox dead-letter path', async () => {
    mocks.apiPost.mockRejectedValue(new ApiError(400, 'unknown column project_name'))
    const r = await startSession(project('p1', 'Planner'))
    if (!r.ok) throw new Error('unreachable')
    await flushed()
    expect(await outbox.peek()).toEqual([])
    expect((await outbox.deadLetters()).map((d) => d.table)).toEqual(['sessions'])
    expect(running.value).toBeNull()
    expect(today.value?.running.session).toBeNull()
    await loadTodaySessions()
    expect(todaySessions.value).toEqual([])
  })

  it('a rejected project row leaves the list once the server answers', async () => {
    rejectEveryRow('unknown column')
    const p = await addProject('Ghost')
    expect(projects.value.map((x) => x.id)).toEqual([p.id])
    await flushed()
    await vi.waitFor(() => { expect(projects.value).toEqual([]) })
  })

  it('an accepted row is left alone (the flush hook path is unchanged)', async () => {
    mocks.apiPost.mockImplementation(async () => { const res: WriteResponse = { applied: 1, rejected: [] }; return res })
    const r = await startSession(project('p1', 'Planner'))
    if (!r.ok) throw new Error('unreachable')
    await flushed()
    expect(running.value?.id).toBe(r.session.id)
    expect(today.value?.running.session?.id).toBe(r.session.id)
    expect(mocks.apiGet).not.toHaveBeenCalledWith('/api/today', 'today')
  })
})
