// Day cache: one signal per date holding the /api/day payload, network-first with the IndexedDB copy as fallback.
// Watched dates re-fetch on visibilitychange, after an outbox flush that touched them, and (today) every 60 s while
// visible. Manual time_blocks are patched in optimistically on enqueue and replaced by the server's answer after
// the flush.
import { effect, signal, type Signal } from '@preact/signals'
import type { DayResult } from '@shared/day'
import type { HealthRow, Project, RoutineItem, TimeBlock } from '@shared/types'
import { localDay } from '@shared/tz'
import { ApiError, apiGet, hasToken, readCache, token } from './api'
import { macLastSeen, macStatus, phoneStatus } from './apps'
import { agoLabel, hhmm } from './format'
import * as outbox from './outbox'
import { dayViewHash, type DayView } from '../router'
import { localToday, tz } from './store'
import { clearRange, daysTouched, insertBlock } from './daymath'

/** How fresh the automated sources are, as GET /api/day reports them (MAX() over screen_hours / automation_health). */
export interface DayFreshness { mac_last_hour: string | null; phone_last_hour: string | null; mac_last_ok_at: string | null }

export interface DayPayload extends DayResult {
  routine_items: RoutineItem[]
  projects: Project[]
  /** Live manual rows overlapping the window, when the API includes them; needed to edit or delete a block. */
  time_blocks?: TimeBlock[]
  /** Present once the Worker sends it; the Day / Week / Month foot shows it. */
  freshness?: DayFreshness
}
export interface DayState {
  date: string
  data: DayPayload | null
  loading: boolean
  error: string | null
  fetchedAt: string | null
  cached: boolean
}

const REFRESH_MS = 60_000
const states = new Map<string, Signal<DayState>>()
const inflight = new Map<string, Promise<void>>()
const watchers = new Map<string, number>()

const cacheKey = (date: string) => `day:${date}` // apiGet stores it as 'cache:day:<date>'

/** The state signal for a date (created empty on first use). */
export function dayState(date: string): Signal<DayState> {
  let s = states.get(date)
  if (!s) {
    s = signal<DayState>({ date, data: null, loading: false, error: null, fetchedAt: null, cached: false })
    states.set(date, s)
  }
  return s
}

/** Fetch one day (cache fallback). Concurrent callers for the same date share one request. */
export function loadDay(date: string): Promise<void> {
  const cur = inflight.get(date)
  if (cur) return cur
  const p = loadOnce(date).finally(() => { inflight.delete(date) })
  inflight.set(date, p)
  return p
}

async function loadOnce(date: string): Promise<void> {
  const s = dayState(date)
  if (!hasToken()) {
    const hit = await readCache<DayPayload>(cacheKey(date))
    if (hit) await apply(s, hit.data, hit.fetchedAt, true)
    return
  }
  s.value = { ...s.value, loading: true }
  try {
    const queuedBefore = await outbox.peek()
    const r = await apiGet<DayPayload>(`/api/day/${date}`, cacheKey(date))
    await apply(s, r.data, r.fetchedAt, r.cached, queuedBefore)
    s.value = { ...s.value, error: null }
  } catch (err) {
    s.value = { ...s.value, error: err instanceof ApiError ? err.message : 'Cannot reach the server' }
    if (!s.value.data) {
      const hit = await readCache<DayPayload>(cacheKey(date))
      if (hit) await apply(s, hit.data, hit.fetchedAt, true)
    }
  } finally {
    s.value = { ...s.value, loading: false }
  }
}

/** Apply a payload (never an older cached one over a newer one), then replay queued manual blocks onto it. */
async function apply(s: Signal<DayState>, data: DayPayload, at: string, cached: boolean, alsoReplay: outbox.OutboxItem[] = []): Promise<void> {
  const cur = s.value
  if (cached && cur.data && cur.fetchedAt && at <= cur.fetchedAt) return
  s.value = { ...cur, data, fetchedAt: at, cached }
  const queued = await outbox.peek()
  const seen = new Set(queued.map((q) => q.id))
  for (const it of [...alsoReplay.filter((q) => !seen.has(q.id)), ...queued]) {
    if (it.table === 'time_blocks') patch(it.row as unknown as TimeBlock)
  }
}

/** Optimistic patch: clear the row's previous range (an edit or delete), then draw the new one. */
function patch(tb: TimeBlock): void {
  const zone = tz.value
  const dates = new Set([localDay(tb.start_ts, zone), localDay(tb.end_ts, zone)])
  for (const date of dates) {
    const s = states.get(date)
    const data = s?.value.data
    if (!s || !data) continue
    const prev = data.time_blocks?.find((b) => b.id === tb.id)
    let next: DayPayload = prev ? { ...data, ...clearRange(data, prev.start_ts, prev.end_ts) } : data
    if (!tb.deleted_at) next = { ...next, ...insertBlock(next, tb) }
    const rows = (next.time_blocks ?? []).filter((b) => b.id !== tb.id)
    next = { ...next, time_blocks: tb.deleted_at ? rows : [...rows, tb] }
    s.value = { ...s.value, data: next }
  }
}

outbox.onEnqueue((table, row) => {
  if (table === 'time_blocks') patch(row as unknown as TimeBlock)
})

outbox.onFlushed((items) => {
  const touched = new Set<string>()
  let all = false
  for (const it of items) {
    const d = daysTouched(it.table, it.row, tz.value)
    if (d === 'all') all = true
    else for (const x of d) touched.add(x)
  }
  for (const date of watchers.keys()) if (all || touched.has(date)) void loadDay(date)
})

// A token that arrives after boot (pasted in Settings, restored from IndexedDB) re-fetches every watched day.
let seenToken: string | null = null
effect(() => {
  const t = token.value
  if (t && t !== seenToken) for (const date of watchers.keys()) void loadDay(date)
  seenToken = t
})

let wired = false
function wire(): void {
  if (wired || typeof document === 'undefined') return
  wired = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    for (const date of watchers.keys()) void loadDay(date)
  })
  setInterval(() => {
    if (document.visibilityState !== 'visible') return
    const t = localToday.value
    if (watchers.has(t)) void loadDay(t)
  }, REFRESH_MS)
}

/** Keep a date fresh while a screen shows it. Returns the unwatch function (use it as a useEffect cleanup). */
export function watchDay(date: string): () => void {
  watchers.set(date, (watchers.get(date) ?? 0) + 1)
  wire()
  return () => {
    const n = (watchers.get(date) ?? 1) - 1
    if (n <= 0) watchers.delete(date)
    else watchers.set(date, n)
  }
}

/** Hash for a date in one of the Day-tab views: '#/day/YYYY-MM-DD' (timeline), '#/day/week[/date]', '#/day/month[/date]'. */
export function dayHash(date: string, view: DayView = 'day'): string {
  return dayViewHash(view, date, localToday.value)
}

export interface FreshnessLine { mac: string; macWarn: boolean; phone: string }

/**
 * "Mac last pushed 4 h ago" · "phone none today" for the foot of the Day / Week / Month views, with the health
 * strip's rules (macStatus / phoneStatus) deciding what counts as stale.
 */
export function freshnessLine(f: DayFreshness, now: Date, zone: string): FreshnessLine {
  const macRow: HealthRow | null = f.mac_last_ok_at
    ? { source: 'mac', last_ok_at: f.mac_last_ok_at, last_error_at: null, last_error: null, detail: null }
    : null
  const health = { rows: macRow ? [macRow] : [], mac_last_hour: f.mac_last_hour, phone_last_hour: f.phone_last_hour }
  const macAt = macLastSeen(health)
  const phoneToday = phoneStatus(health, now, zone).text.startsWith('Phone: today')
  return {
    mac: macAt ? `Mac last pushed ${agoLabel(macAt, now)}` : 'Mac no data yet',
    macWarn: macStatus(health, now, zone).warn,
    phone: phoneToday && f.phone_last_hour ? `phone through ${hhmm(f.phone_last_hour, zone)}` : 'phone none today',
  }
}
