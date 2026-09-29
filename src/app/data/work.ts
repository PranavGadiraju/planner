// Work data: projects, today's sessions, the running session and the weekly summary as signals; loaders through
// apiGet (network-first, IndexedDB fallback) and write helpers that build full rows and queue them in the outbox.
// Queued session rows are mirrored optimistically into today.value.running.session (so Today's running strip and
// the Day ring follow a start/end at once) and into the lists here; the server's answer replaces them after the
// flush. The pure helpers at the bottom (durations, spans, week grouping, the evening check-in line) are
// unit-tested in test/app-work.test.ts.
import { batch, computed, effect, signal } from '@preact/signals'
import type { Project, RoutineItem, RoutineLog, Session, TodayPayload } from '@shared/types'
import { addDays, dayWindow, localDay, localHHMM, weekStart, zonedToUTC } from '@shared/tz'
import { routineIsDone } from '@shared/routine'
import { ApiError, apiGet, hasToken, readCache } from './api'
import * as outbox from './outbox'
import { loadToday, localToday, today, tz } from './store'
import { durationLabel, uuid } from './format'

export type SessionRow = Session & { project_name: string }
export interface WeekDay { local_day: string; seconds: number; by_project: Record<string, number> }
export interface WeekPayload {
  day: string
  week_start: string
  days: WeekDay[]
  last_week: { week_start: string; days: WeekDay[] }
  projects: Pick<Project, 'id' | 'name' | 'kind' | 'color' | 'position' | 'archived_at'>[]
}
export interface SessionsPayload { from: string; to: string; sessions: SessionRow[]; by_project: Record<string, number>; by_day: Record<string, number> }
export interface LogEntry {
  id: string
  local_day: string
  started_at: string
  ended_at: string | null
  duration_s: number | null
  note: string | null
  source: Session['source']
}
export interface ProjectLogPayload { project: Project; entries: LogEntry[]; count: number; total_s: number }

export const MAX_SESSION_MS = 24 * 3600_000
export const DURATION_CHIPS = [25, 50, 90] as const
/** Project colours offered in the management sheet (null = the study colour). */
export const PROJECT_COLORS: readonly string[] = ['#0ea5e9', '#22c55e', '#f97316', '#a855f7', '#ec4899', '#eab308', '#14b8a6', '#f43f5e']

// ---- signals ---------------------------------------------------------------------------------------

/** Every non-deleted project, archived ones included (archived_at set), ordered by position then name. */
export const projects = signal<Project[]>([])
export const activeProjects = computed(() => projects.value.filter((p) => !p.archived_at))
/** Sessions of `sessionsDay` (today when loaded through loadTodaySessions), oldest first. */
export const todaySessions = signal<SessionRow[]>([])
export const sessionsDay = signal<string | null>(null)
export const week = signal<WeekPayload | null>(null)
export const workLoading = signal(false)
export const workError = signal<string | null>(null)
/** Freshness of the last successful load: 'live', 'cached' (served from IndexedDB) or null before any load. */
export const workSource = signal<'live' | 'cached' | null>(null)

const runningLocal = signal<SessionRow | null>(null)
/** The running session: from the Today payload when there is one, else whatever was started locally. */
export const running = computed<SessionRow | null>(() => {
  const p = today.value
  const s = p ? p.running.session : runningLocal.value
  return s && !s.deleted_at && !s.ended_at ? s : null
})
/** Seconds logged today (finished sessions only). */
export const todaySeconds = computed(() => todaySessions.value.reduce((a, s) => a + (s.ended_at && !s.deleted_at ? s.duration_s ?? 0 : 0), 0))

// Names seen on rows that passed through here (a project started before the list loaded, a cached session), so
// an optimistic row never has to fall back to "Session".
const nameHints = new Map<string, string>()

export function projectById(id: string): Project | undefined {
  return projects.value.find((p) => p.id === id)
}
export function projectName(id: string): string {
  return (
    projectById(id)?.name ??
    todaySessions.value.find((s) => s.project_id === id)?.project_name ??
    week.value?.projects.find((p) => p.id === id)?.name ??
    nameHints.get(id) ??
    'Session'
  )
}
export function projectColor(p: Pick<Project, 'color'> | undefined | null): string {
  return p?.color ?? 'var(--cat-study)'
}

// ---- loading ----------------------------------------------------------------------------------------

async function fetchInto<T>(path: string, key: string, apply: (data: T, cached: boolean) => void): Promise<void> {
  if (!hasToken()) {
    const hit = await readCache<T>(key)
    if (hit) apply(hit.data, true)
    return
  }
  try {
    const r = await apiGet<T>(path, key)
    apply(r.data, r.cached)
    workError.value = null
  } catch (err) {
    workError.value = err instanceof ApiError ? err.message : 'Cannot reach the server'
  }
}

export async function loadProjects(): Promise<void> {
  await fetchInto<{ projects: Project[] }>('/api/projects', 'projects', (d, cached) => {
    projects.value = sortProjects(replayProjects(d.projects))
    workSource.value = cached ? 'cached' : 'live'
  })
}

export async function loadTodaySessions(): Promise<void> {
  const day = localToday.value
  await fetchInto<SessionsPayload>(`/api/sessions?from=${day}&to=${day}`, `sessions:${day}`, (d, cached) => {
    batch(() => {
      sessionsDay.value = day
      todaySessions.value = sortSessions(replaySessions(d.sessions, day))
      workSource.value = cached ? 'cached' : 'live'
    })
  })
}

export async function loadWeek(): Promise<void> {
  const day = localToday.value
  await fetchInto<WeekPayload>(`/api/work/week?day=${day}`, `work:week:${weekStart(day)}`, (d, cached) => {
    week.value = d
    workSource.value = cached ? 'cached' : 'live'
    patchWeekFromToday()
  })
}

let inflight: Promise<void> | null = null
/** Projects + today's sessions + the week, sharing one in-flight round for concurrent callers. */
export function loadWork(): Promise<void> {
  if (inflight) return inflight
  workLoading.value = true
  inflight = Promise.all([loadProjects(), loadTodaySessions(), loadWeek()])
    .then(() => undefined)
    .finally(() => {
      inflight = null
      workLoading.value = false
    })
  return inflight
}

export async function loadProjectLog(id: string, limit = 200): Promise<{ data: ProjectLogPayload; cached: boolean } | null> {
  const key = `project:log:${id}`
  if (!hasToken()) {
    const hit = await readCache<ProjectLogPayload>(key)
    return hit ? { data: hit.data, cached: true } : null
  }
  const r = await apiGet<ProjectLogPayload>(`/api/projects/${encodeURIComponent(id)}/log?limit=${limit}`, key)
  return { data: r.data, cached: r.cached }
}

// ---- optimistic mirror ---------------------------------------------------------------------------------

// Rows queued in the outbox but not yet accepted by the server, by id (the newest version of each). They are
// replayed over every server answer so an offline refresh never hides a session started a minute ago.
const pendingSessions = new Map<string, Session>()
const pendingProjects = new Map<string, Project>()

function sortProjects(list: Project[]): Project[] {
  return [...list].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))
}
function sortSessions(list: SessionRow[]): SessionRow[] {
  return [...list].sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0))
}
function withName(row: Session): SessionRow {
  const cur = 'project_name' in row && typeof (row as SessionRow).project_name === 'string' ? (row as SessionRow).project_name : null
  if (cur) nameHints.set(row.project_id, cur)
  return { ...row, project_name: cur ?? projectName(row.project_id) }
}
/** The row without project_name (a display field the server would reject as an unknown column). */
function dbRow(row: Session | SessionRow): Session {
  const { project_name: _drop, ...rest } = row as SessionRow
  return rest
}

function upsertSession(list: SessionRow[], row: Session, day: string): SessionRow[] {
  const rest = list.filter((s) => s.id !== row.id)
  if (row.deleted_at || row.local_day !== day) return rest
  return sortSessions([...rest, withName(row)])
}
function replaySessions(list: SessionRow[], day: string): SessionRow[] {
  let out = list
  for (const row of pendingSessions.values()) out = upsertSession(out, row, day)
  return out
}
function replayProjects(list: Project[]): Project[] {
  let out = list
  for (const row of pendingProjects.values()) {
    const rest = out.filter((p) => p.id !== row.id)
    out = row.deleted_at ? rest : [...rest, row]
  }
  return out
}

/** What the running session should be given the server's answer and the rows still queued (newest wins). */
export function desiredRunning(server: SessionRow | null, pending: Iterable<Session>): SessionRow | null {
  let r: SessionRow | null = server && !server.deleted_at && !server.ended_at ? server : null
  const rows = [...pending].sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : 0))
  for (const row of rows) {
    const live = !row.deleted_at && !row.ended_at
    if (r && row.id === r.id) r = live ? withName(row) : null
    else if (live) r = withName(row)
  }
  return r
}
function sameRunning(a: SessionRow | null, b: SessionRow | null): boolean {
  if (a === null || b === null) return a === b
  return a.id === b.id && a.updated_at === b.updated_at && a.ended_at === b.ended_at && a.deleted_at === b.deleted_at
}

/** Make today.value.running.session (or the local stand-in) agree with the queued rows. Cheap and idempotent. */
function reconcileRunning(): void {
  const p = today.value
  if (!p) {
    const want = desiredRunning(runningLocal.value, pendingSessions.values())
    if (!sameRunning(want, runningLocal.value)) runningLocal.value = want
    return
  }
  const want = desiredRunning(p.running.session, pendingSessions.values())
  if (!sameRunning(want, p.running.session)) today.value = { ...p, running: { ...p.running, session: want } }
}

/** Recompute today's bar of the week from today's list (exact, since the list is complete for the day). */
function patchWeekFromToday(): void {
  const w = week.value
  const day = localToday.value
  if (!w || sessionsDay.value !== day) return
  const i = w.days.findIndex((d) => d.local_day === day)
  if (i < 0) return
  const by: Record<string, number> = {}
  let total = 0
  for (const s of todaySessions.value) {
    if (!s.ended_at || s.deleted_at || !s.duration_s) continue
    by[s.project_id] = (by[s.project_id] ?? 0) + s.duration_s
    total += s.duration_s
  }
  const cur = w.days[i]
  if (cur && cur.seconds === total && JSON.stringify(cur.by_project) === JSON.stringify(by)) return
  week.value = { ...w, days: w.days.map((d, j) => (j === i ? { ...d, seconds: total, by_project: by } : d)) }
}

function applySessionRow(row: Session): void {
  pendingSessions.set(row.id, row)
  batch(() => {
    const day = sessionsDay.value ?? localToday.value
    todaySessions.value = upsertSession(todaySessions.value, row, day)
    reconcileRunning()
    patchWeekFromToday()
  })
}
function applyProjectRow(row: Project): void {
  pendingProjects.set(row.id, row)
  const rest = projects.value.filter((p) => p.id !== row.id)
  projects.value = sortProjects(row.deleted_at ? rest : [...rest, row])
}

outbox.onEnqueue((table, row) => {
  if (table === 'sessions') applySessionRow(row as unknown as Session)
  else if (table === 'projects') applyProjectRow(row as unknown as Project)
})

/**
 * The server refused a queued row (a project it does not know yet, a validation failure): the outbox dropped it, so
 * it must stop being replayed over server answers and the screens go back to what the server holds. `key` is the
 * row id, or "N rows" when a whole batch was buried (then every pending row of that table is gone). main.tsx
 * already toasts the reason. Exported for the unit tests; wired below.
 */
export function handleReject(table: string, key: string): void {
  if (table === 'sessions') {
    const ids = pendingSessions.has(key) ? [key] : [...pendingSessions.keys()]
    if (ids.length === 0) return
    const gone = new Set(ids)
    batch(() => {
      for (const id of ids) pendingSessions.delete(id)
      const p = today.value
      if (p && p.running.session && gone.has(p.running.session.id)) today.value = { ...p, running: { ...p.running, session: null } }
      if (runningLocal.value && gone.has(runningLocal.value.id)) runningLocal.value = null
      todaySessions.value = todaySessions.value.filter((s) => !gone.has(s.id))
      reconcileRunning()
      patchWeekFromToday()
    })
    void loadToday()
    void loadTodaySessions()
    void loadWeek()
  } else if (table === 'projects') {
    const ids = pendingProjects.has(key) ? [key] : [...pendingProjects.keys()]
    if (ids.length === 0) return
    for (const id of ids) pendingProjects.delete(id)
    void loadProjects()
  }
}
outbox.onReject((table, key) => handleReject(table, key))

outbox.onFlushed((items) => {
  let sessionsTouched = false
  let projectsTouched = false
  for (const it of items) {
    const id = typeof it.row['id'] === 'string' ? it.row['id'] : null
    const at = typeof it.row['updated_at'] === 'string' ? it.row['updated_at'] : ''
    if (it.table === 'sessions') {
      sessionsTouched = true
      const p = id ? pendingSessions.get(id) : undefined
      if (id && p && p.updated_at <= at) pendingSessions.delete(id)
    } else if (it.table === 'projects') {
      projectsTouched = true
      const p = id ? pendingProjects.get(id) : undefined
      if (id && p && p.updated_at <= at) pendingProjects.delete(id)
    }
  }
  if (projectsTouched) void loadProjects()
  if (sessionsTouched) {
    void loadTodaySessions()
    void loadWeek()
  }
})

// A fresh Today payload (server truth) must not hide a session that is still only in the outbox.
effect(() => {
  today.value
  reconcileRunning()
})

// Rows queued before this page loaded (started offline yesterday evening, say) count as pending too.
void outbox.peek().then((items) => {
  for (const it of items) {
    if (it.table === 'sessions') pendingSessions.set(String(it.row['id']), it.row as unknown as Session)
    else if (it.table === 'projects') pendingProjects.set(String(it.row['id']), it.row as unknown as Project)
  }
  if (items.length) {
    batch(() => {
      projects.value = sortProjects(replayProjects(projects.value))
      todaySessions.value = replaySessions(todaySessions.value, sessionsDay.value ?? localToday.value)
      reconcileRunning()
    })
  }
}).catch(() => {})

// ---- write helpers --------------------------------------------------------------------------------------

// Strictly increasing, so two rows of the same id queued in one millisecond (an end right after an edit, say) never
// share an updated_at: the Worker's guard is `excluded.updated_at > sessions.updated_at` and would drop the second.
let lastStamp = 0
function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return new Date(lastStamp).toISOString()
}

async function enqueueSession(row: Session | SessionRow): Promise<SessionRow> {
  const named = withName(row) // records the name hint before the hook needs it
  const db = dbRow(named)
  await outbox.enqueue('sessions', db as unknown as Record<string, unknown>)
  return withName(db)
}
async function enqueueProject(row: Project): Promise<Project> {
  await outbox.enqueue('projects', row as unknown as Record<string, unknown>)
  return row
}

export async function addProject(name: string, kind: Project['kind'] = 'project', color: string | null = null): Promise<Project> {
  const ts = stamp()
  const position = projects.value.reduce((m, p) => Math.max(m, p.position), 0) + 1
  return enqueueProject({ id: uuid(), name: name.trim(), kind, color, position, archived_at: null, created_at: ts, updated_at: ts, deleted_at: null })
}
export function updateProject(p: Project, patch: Partial<Pick<Project, 'name' | 'kind' | 'color' | 'position' | 'archived_at'>>): Promise<Project> {
  return enqueueProject({ ...p, ...patch, updated_at: stamp() })
}
export function renameProject(p: Project, name: string): Promise<Project> {
  return updateProject(p, { name: name.trim() })
}
export function archiveProject(p: Project, archived = true): Promise<Project> {
  return updateProject(p, { archived_at: archived ? stamp() : null })
}

export type StartResult = { ok: true; session: SessionRow } | { ok: false; running: SessionRow }

/** Start a session now. Refuses (returning the running one) while another session runs: end it first. */
export async function startSession(project: Project, at: Date = new Date()): Promise<StartResult> {
  const cur = running.value
  if (cur) return { ok: false, running: cur }
  const ts = at.toISOString()
  const row: SessionRow = {
    id: uuid(), project_id: project.id, started_at: ts, ended_at: null, local_day: localDay(at, tz.value), duration_s: null,
    note: null, source: 'app', ended_by: null, created_at: ts, updated_at: stamp(), deleted_at: null, project_name: project.name,
  }
  return { ok: true, session: await enqueueSession(row) }
}

/**
 * End a session with its note; `endedAt` defaults to now and is never before the start. A project change made in
 * the end sheet travels in the same row (`patch`): one row per end, so the Worker's updated_at guard can never
 * drop the end behind an edit of the same session.
 */
export async function endSession(session: Session, note: string, endedAt: Date = new Date(), patch: Pick<SessionPatch, 'project_id'> = {}): Promise<SessionRow> {
  const start = new Date(session.started_at).getTime()
  const end = Math.max(start, Math.min(endedAt.getTime(), start + MAX_SESSION_MS))
  const endIso = new Date(end).toISOString()
  return enqueueSession({
    ...dbRow(session), ...patch, ended_at: endIso, duration_s: durationSeconds(session.started_at, endIso), note: note.trim() || null,
    ended_by: 'user', updated_at: stamp(), deleted_at: null,
  })
}

export interface ManualInput { minutes?: number; start?: Date; end?: Date; note?: string; day?: string }

/** A finished session typed in by hand: minutes (25 / 50 / 90 or any), or start/end, on a day (default today). */
export async function addManualSession(project: Project, input: ManualInput): Promise<SessionRow> {
  const span = spanFor(input, input.day ?? localToday.value, tz.value, new Date())
  const ts = stamp()
  return enqueueSession({
    id: uuid(), project_id: project.id, started_at: span.started_at, ended_at: span.ended_at, local_day: span.local_day,
    duration_s: span.duration_s, note: input.note?.trim() || null, source: 'app', ended_by: 'user', created_at: ts, updated_at: ts, deleted_at: null,
    project_name: project.name,
  })
}

export interface SessionPatch { project_id?: string; started_at?: string; ended_at?: string | null; note?: string | null }

/** Edit a session's project, times or note; duration_s and local_day follow the times. */
export async function editSession(session: Session, patch: SessionPatch): Promise<SessionRow> {
  const next: Session = { ...dbRow(session), ...patch, updated_at: stamp(), deleted_at: null }
  if (typeof patch.note === 'string') next.note = patch.note.trim() || null
  next.local_day = localDay(next.started_at, tz.value)
  next.duration_s = next.ended_at ? durationSeconds(next.started_at, next.ended_at) : null
  if (next.ended_at && next.duration_s !== null && next.duration_s < 0) throw new Error('End must be after start')
  return enqueueSession(next)
}

/** Tombstone a session (a discarded running one, or a mistake). */
export async function deleteSession(session: Session): Promise<void> {
  const ts = stamp()
  await enqueueSession({ ...dbRow(session), updated_at: ts, deleted_at: ts })
}

// ---- pure helpers (unit-tested) --------------------------------------------------------------------------

export function durationSeconds(startIso: string, endIso: string): number {
  return Math.max(0, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000))
}
export function elapsedSeconds(startIso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(startIso).getTime()) / 1000))
}
/** "1h30" / "45 min" from seconds (finished sessions, totals). */
export function secondsLabel(s: number): string {
  return durationLabel(s / 60)
}
/** "1:05:20" / "12:34" for a live timer. */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(r).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`
}

export interface Span { started_at: string; ended_at: string; duration_s: number; local_day: string }

/**
 * A finished span from {minutes} | {start, end} | {start, minutes} | {end, minutes} (the same rules as the
 * Worker's POST /api/sessions): minutes alone ends now on today (or at the same wall-clock time on `day`) and
 * never starts before local midnight of `day`; local_day is the day of the start.
 */
export function spanFor(input: { minutes?: number; start?: Date; end?: Date }, day: string, tzName: string, now: Date): Span {
  const minutes = input.minutes
  if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0 || minutes > MAX_SESSION_MS / 60_000)) throw new Error('Minutes must be between 1 and 1440')
  let start: Date
  let end: Date
  if (input.start && input.end) {
    start = input.start
    end = input.end
    if (end.getTime() <= start.getTime()) end = new Date(end.getTime() + 86400_000)
  } else if (input.start) {
    if (minutes === undefined) throw new Error('Choose a duration')
    start = input.start
    end = new Date(start.getTime() + minutes * 60_000)
  } else if (input.end) {
    if (minutes === undefined) throw new Error('Choose a duration')
    end = input.end
    start = new Date(end.getTime() - minutes * 60_000)
  } else {
    if (minutes === undefined) throw new Error('Choose a duration')
    end = day === localDay(now, tzName) ? now : zonedToUTC(day, localHHMM(now, tzName), tzName)
    start = new Date(end.getTime() - minutes * 60_000)
    const midnight = dayWindow(day, tzName).start
    if (start.getTime() < midnight.getTime()) {
      start = midnight
      end = new Date(start.getTime() + minutes * 60_000)
    }
  }
  if (end.getTime() - start.getTime() > MAX_SESSION_MS) throw new Error('A session cannot be longer than 24 h')
  const s = start.toISOString()
  const e = end.toISOString()
  return { started_at: s, ended_at: e, duration_s: durationSeconds(s, e), local_day: localDay(start, tzName) }
}

export interface WeekGroup<T> { week_start: string; entries: T[]; seconds: number }

/** Entries grouped by Mon-Sun week (newest week first; entries keep their order within a week). */
export function groupByWeek<T extends { local_day: string; duration_s: number | null }>(entries: readonly T[]): WeekGroup<T>[] {
  const groups = new Map<string, WeekGroup<T>>()
  for (const e of entries) {
    const ws = weekStart(e.local_day)
    let g = groups.get(ws)
    if (!g) {
      g = { week_start: ws, entries: [], seconds: 0 }
      groups.set(ws, g)
    }
    g.entries.push(e)
    g.seconds += e.duration_s ?? 0
  }
  return [...groups.values()].sort((a, b) => (a.week_start < b.week_start ? 1 : a.week_start > b.week_start ? -1 : 0))
}

export interface ProjectBar { project_id: string; name: string; color: string | null; this_week: number; last_week: number }

/** Per-project seconds this week vs last week, largest first; projects with nothing in either week are left out. */
export function weekBars(w: Pick<WeekPayload, 'days' | 'last_week' | 'projects'>): ProjectBar[] {
  const sum = (days: WeekDay[]): Record<string, number> => {
    const out: Record<string, number> = {}
    for (const d of days) for (const [id, s] of Object.entries(d.by_project)) out[id] = (out[id] ?? 0) + s
    return out
  }
  const cur = sum(w.days)
  const last = sum(w.last_week.days)
  const ids = new Set([...Object.keys(cur), ...Object.keys(last)])
  const bars: ProjectBar[] = []
  for (const id of ids) {
    const p = w.projects.find((x) => x.id === id)
    bars.push({ project_id: id, name: p?.name ?? 'Session', color: p?.color ?? null, this_week: cur[id] ?? 0, last_week: last[id] ?? 0 })
  }
  return bars.sort((a, b) => b.this_week - a.this_week || b.last_week - a.last_week || a.name.localeCompare(b.name))
}

/** Which of the week's days are elapsed so far (Mon..today), for the "so far" comparison of last week. */
export function elapsedDays(weekStartDay: string, todayDay: string): number {
  for (let i = 0; i < 7; i++) if (addDays(weekStartDay, i) === todayDay) return i + 1
  return todayDay > weekStartDay ? 7 : 0
}

export interface CheckinInput {
  routine_items: Pick<RoutineItem, 'id' | 'name'>[]
  routine_log: Pick<RoutineLog, 'local_day' | 'item_id' | 'started_at' | 'ended_at' | 'deleted_at'>[]
  running: { workout: { name: string | null } | null; session: SessionRow | null }
}

/**
 * The evening check-in pre-fill: "planner 1h30 (built the sync layer) · Push workout · routine 3/5" from today's
 * sessions (notes in brackets, the running one counted so far), the workouts seen today and the routine tally.
 */
export function checkinSummary(p: CheckinInput, sessions: readonly SessionRow[], workouts: readonly string[], day: string, at: Date): string {
  const parts: string[] = []
  const by = new Map<string, { name: string; seconds: number; notes: string[] }>()
  const seen = new Set<string>()
  const add = (s: SessionRow) => {
    if (s.deleted_at || s.local_day !== day || seen.has(s.id)) return
    seen.add(s.id)
    const secs = s.ended_at ? s.duration_s ?? 0 : elapsedSeconds(s.started_at, at)
    const e = by.get(s.project_id) ?? { name: s.project_name, seconds: 0, notes: [] }
    e.seconds += secs
    if (s.note) e.notes.push(s.note)
    by.set(s.project_id, e)
  }
  for (const s of sessions) add(s)
  if (p.running.session) add(p.running.session)
  for (const e of [...by.values()].sort((a, b) => b.seconds - a.seconds)) {
    if (e.seconds < 60) continue
    parts.push(`${e.name} ${secondsLabel(e.seconds)}${e.notes.length ? ` (${e.notes.join('; ')})` : ''}`)
  }
  const names = new Set<string>(workouts.map((w) => w.trim()).filter(Boolean))
  const rw = p.running.workout
  if (rw) names.add(rw.name?.trim() || 'Workout')
  for (const w of names) parts.push(/workout/i.test(w) ? w : `${w} workout`)
  if (p.routine_items.length) {
    const logs = p.routine_log.filter((l) => l.local_day === day && !l.deleted_at)
    const done = p.routine_items.filter((i) => {
      const l = logs.find((x) => x.item_id === i.id)
      return l ? routineIsDone(l as RoutineLog, at) : false
    }).length
    parts.push(`routine ${done}/${p.routine_items.length}`)
  }
  return parts.join(' · ')
}

/** Names of the workouts on a day's chart (blocks drawn from the workouts table, not routine runs). */
export function workoutNames(blocks: readonly { category: string; source: string; label: string }[]): string[] {
  const out: string[] = []
  for (const b of blocks) if (b.category === 'workout' && b.source === 'workout' && !out.includes(b.label)) out.push(b.label)
  return out
}

/** Hash of a project's changelog screen. */
export function projectHash(id: string): string {
  return `#/work/p/${encodeURIComponent(id)}`
}

// Re-exported for screens that only import this module.
export type { Project, Session, TodayPayload }
