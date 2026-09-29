// App state: the Today payload, settings and sync state as signals, plus the local write helpers that
// mirror the shared state machines and push idempotent upserts through the outbox.
import { batch, computed, effect, signal } from '@preact/signals'
import { get, set } from 'idb-keyval'
import { DEFAULT_SETTINGS } from '@shared/types'
import type { Checkin, RoutineItem, RoutineLog, Settings, Sleep, TimeBlock, TodayPayload } from '@shared/types'
import { applyRoutineTap, type RoutineTapAction } from '@shared/routine'
import { OPEN_SLEEP_MAX_MS, applyBedTap, applyWake, nightOf, type BedTapAction } from '@shared/sleep'
import { addDays, localDay } from '@shared/tz'
import { ApiError, apiGet, authFailed, hasToken, offline, readCache, token } from './api'
import * as outbox from './outbox'
import { uuid } from './format'

export const today = signal<TodayPayload | null>(null)
export const settings = signal<Settings>(DEFAULT_SETTINGS)
export const loading = signal(false)
export const loadError = signal<string | null>(null)
export const fetchedAt = signal<string | null>(null)
/** Every routine item ever seen (active or not), for the editor. Persisted in IndexedDB. */
export const allRoutineItems = signal<RoutineItem[]>([])
/** Ticks every 30 s and on visibility so elapsed timers re-render. */
export const now = signal(new Date())

export type SyncState = 'no-token' | 'unauthorized' | 'pending' | 'offline' | 'synced'
export const syncState = computed<SyncState>(() => {
  if (!token.value) return 'no-token'
  if (authFailed.value || outbox.status.value === 'unauthorized') return 'unauthorized'
  if (outbox.pending.value > 0) return 'pending'
  if (offline.value) return 'offline'
  return 'synced'
})

export const tz = computed(() => today.value?.tz ?? settings.value.tz)
export const localToday = computed(() => localDay(now.value, tz.value))

// ---- loading --------------------------------------------------------------------------------------

let inflightLoad: Promise<void> | null = null
/** Fetch /api/today (cache fallback) and apply it. Concurrent callers share one request. */
export function loadToday(): Promise<void> {
  if (inflightLoad) return inflightLoad
  inflightLoad = loadTodayOnce().finally(() => { inflightLoad = null })
  return inflightLoad
}

async function loadTodayOnce(): Promise<void> {
  if (!hasToken()) {
    loadError.value = null
    const hit = await readCache<TodayPayload>('today')
    if (hit) await applyPayload(hit.data, hit.fetchedAt, true)
    return
  }
  loading.value = true
  try {
    // Snapshot the queue first: rows flushed while the request is in flight may not be in the answer yet.
    const queuedBefore = await outbox.peek()
    const r = await apiGet<TodayPayload>('/api/today', 'today')
    await applyPayload(r.data, r.fetchedAt, r.cached, queuedBefore)
    loadError.value = null
  } catch (err) {
    loadError.value = err instanceof ApiError ? err.message : 'Cannot reach the server'
    if (!today.value) {
      const hit = await readCache<TodayPayload>('today')
      if (hit) await applyPayload(hit.data, hit.fetchedAt, true)
    }
  } finally {
    loading.value = false
  }
}

/**
 * Apply a payload, then replay every queued (unsent) row on top of it so an offline refresh never hides an
 * optimistic change. A cached payload older than the one already on screen is ignored.
 */
async function applyPayload(p: TodayPayload, at: string, cached: boolean, alsoReplay: outbox.OutboxItem[] = []): Promise<void> {
  if (cached && today.value && fetchedAt.value && at <= fetchedAt.value) return
  batch(() => {
    today.value = p
    settings.value = { ...DEFAULT_SETTINGS, ...p.settings, targets: { ...DEFAULT_SETTINGS.targets, ...p.settings.targets } }
    fetchedAt.value = at
  })
  mergeRoutineItems(p.routine_items)
  const queued = await outbox.peek()
  const seen = new Set(queued.map((q) => q.id))
  const replay = [...alsoReplay.filter((q) => !seen.has(q.id)), ...queued]
  if (replay.length) batch(() => { for (const it of replay) applyLocal(it.table, it.row) })
}

export async function loadSettingsFromServer(): Promise<Settings> {
  const r = await apiGet<Settings>('/api/settings', 'settings')
  settings.value = { ...DEFAULT_SETTINGS, ...r.data, targets: { ...DEFAULT_SETTINGS.targets, ...r.data.targets } }
  return settings.value
}

// ---- routine items cache ---------------------------------------------------------------------------

const ROUTINE_CACHE = 'routine_items_all'
export async function loadRoutineItemsCache(): Promise<void> {
  try {
    const cached = await get<RoutineItem[]>(ROUTINE_CACHE)
    if (Array.isArray(cached)) mergeRoutineItems(cached)
  } catch { /* ignore */ }
}
function mergeRoutineItems(rows: RoutineItem[]): void {
  const map = new Map(allRoutineItems.value.map((r) => [r.id, r]))
  for (const r of rows) {
    const cur = map.get(r.id)
    if (!cur || r.updated_at >= cur.updated_at) map.set(r.id, r)
  }
  const merged = [...map.values()].filter((r) => !r.deleted_at).sort((a, b) => a.position - b.position)
  allRoutineItems.value = merged
  void set(ROUTINE_CACHE, merged).catch(() => {})
}

// ---- optimistic local mirror -----------------------------------------------------------------------

/** Mirror one queued row into the Today payload (and settings). Idempotent, so replaying the queue is safe. */
export function applyLocal(table: string, row: Record<string, unknown>): void {
  const p = today.value
  switch (table) {
    case 'routine_log': {
      const r = row as unknown as RoutineLog
      if (!p) return
      const rest = p.routine_log.filter((x) => !(x.local_day === r.local_day && x.item_id === r.item_id))
      today.value = { ...p, routine_log: r.deleted_at ? rest : [...rest, r] }
      return
    }
    case 'sleep': {
      const r = row as unknown as Sleep
      if (!p) return
      const tonight = nightOf(now.value, p.tz)
      const lastNight = addDays(tonight, -1)
      const s = { ...p.sleep }
      if (r.night_of === tonight) s.tonight = r
      if (r.night_of === lastNight) s.last_night = r
      const candidates = [s.tonight, s.last_night].filter((x): x is Sleep => !!x && !x.deleted_at && !x.wake_ts)
      s.open = candidates[0] ?? null
      today.value = { ...p, sleep: s }
      return
    }
    case 'checkins': {
      if (!p) return
      today.value = { ...p, checkin: row as unknown as Checkin }
      return
    }
    case 'routine_items': {
      const r = row as unknown as RoutineItem
      mergeRoutineItems([r])
      if (!p) return
      const rest = p.routine_items.filter((x) => x.id !== r.id)
      const next = r.active && !r.deleted_at ? [...rest, r] : rest
      today.value = { ...p, routine_items: next.sort((a, b) => a.position - b.position) }
      return
    }
    case 'settings': {
      const { key, value } = row as { key: keyof Settings; value: string }
      try {
        const parsed = JSON.parse(value) as unknown
        settings.value = { ...settings.value, [key]: parsed }
        if (p) {
          // The timezone decides what "today" is everywhere, so the payload's tz follows the setting at once.
          const tzNext = key === 'tz' && typeof parsed === 'string' && parsed ? parsed : p.tz
          today.value = { ...p, settings: settings.value, tz: tzNext }
        }
      } catch { /* ignore */ }
      return
    }
    default:
      return
  }
}

outbox.onEnqueue(applyLocal)

// ---- write helpers ---------------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * The sleep row a wake signal may close: open (no wake_ts), belonging to today or yesterday by calendar day
 * (not by nightOf, which would shift at noon), and not so old that it is clearly a forgotten tap.
 */
function openSleepRow(p: TodayPayload, at: Date): Sleep | null {
  const day = localDay(at, p.tz)
  const yesterday = addDays(day, -1)
  const rows = [p.sleep.open, p.sleep.tonight, p.sleep.last_night]
  for (const r of rows) {
    if (!r || r.deleted_at || r.wake_ts) continue
    if (r.night_of !== day && r.night_of !== yesterday) continue
    if (at.getTime() - new Date(r.bed_ts).getTime() > OPEN_SLEEP_MAX_MS) continue
    return r
  }
  return null
}

export interface LocalTapResult { action: RoutineTapAction; message: string; woke: boolean }

/** Start or finish a routine item now (mirrors POST /api/tap for the app role, but through the outbox). */
export async function tapRoutineLocal(itemId: string): Promise<LocalTapResult> {
  const p = today.value
  if (!p) throw new Error('Today not loaded')
  const at = new Date()
  const day = localDay(at, p.tz)
  const item = p.routine_items.find((i) => i.id === itemId)
  const existing = p.routine_log.find((r) => r.local_day === day && r.item_id === itemId) ?? null
  const res = applyRoutineTap(existing, at, { local_day: day, item_id: itemId, source: 'app' })
  let woke = false
  if (res.changed) {
    if (res.action === 'routine_started') {
      const firstStartToday = !p.routine_log.some((r) => r.local_day === day && !r.deleted_at && r.item_id !== itemId)
      if (firstStartToday) {
        const closed = applyWake(openSleepRow(p, at), at, 'routine')
        if (closed) { woke = true; await outbox.enqueue('sleep', closed as unknown as Record<string, unknown>) }
      }
    }
    await outbox.enqueue('routine_log', res.row as unknown as Record<string, unknown>)
  }
  const name = item?.name ?? itemId
  const message = tapMessage(res.action, name, res.row, p.tz)
  return { action: res.action, message, woke }
}

function tapMessage(action: RoutineTapAction, name: string, row: RoutineLog, tzName: string): string {
  const t = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tzName })
  switch (action) {
    case 'routine_started': return `${name} started ${t(row.started_at)}`
    case 'routine_finished': {
      const min = Math.max(1, Math.round((new Date(row.ended_at ?? row.started_at).getTime() - new Date(row.started_at).getTime()) / 60000))
      return `${name} done · ${min} min`
    }
    case 'routine_duplicate': return `${name} already started`
    case 'routine_ignored': return 'Tap again in a minute to finish'
    case 'routine_already_done': return 'Already done'
  }
}

/** Overwrite start/end for today's row of an item (times are UTC ISO). */
export async function editRoutineTimes(itemId: string, startedAt: string, endedAt: string | null): Promise<void> {
  const p = today.value
  if (!p) return
  const day = localDay(new Date(), p.tz)
  const existing = p.routine_log.find((r) => r.local_day === day && r.item_id === itemId)
  const row: RoutineLog = {
    local_day: day, item_id: itemId, started_at: startedAt, ended_at: endedAt,
    source: existing?.source ?? 'app', updated_at: nowIso(), deleted_at: null,
  }
  await outbox.enqueue('routine_log', row as unknown as Record<string, unknown>)
}

/** Tombstone today's row for an item; a later tap re-activates it. */
export async function undoRoutine(itemId: string): Promise<void> {
  const p = today.value
  if (!p) return
  const day = localDay(new Date(), p.tz)
  const existing = p.routine_log.find((r) => r.local_day === day && r.item_id === itemId)
  if (!existing) return
  const ts = nowIso()
  await outbox.enqueue('routine_log', { ...existing, updated_at: ts, deleted_at: ts } as unknown as Record<string, unknown>)
}

export interface LocalBedResult { action: BedTapAction; message: string }

/** The in-app "In bed" button: same state machine as the nightstand sticker. */
export async function bedTapLocal(): Promise<LocalBedResult> {
  const p = today.value
  if (!p) throw new Error('Today not loaded')
  const at = new Date()
  const night = nightOf(at, p.tz)
  const existing = p.sleep.tonight && p.sleep.tonight.night_of === night ? p.sleep.tonight : null
  const res = applyBedTap(existing, at, p.tz, settings.value, 'app')
  if (res.changed && res.row) {
    if (res.nap) {
      const ts = nowIso()
      const nap: TimeBlock = {
        id: uuid(), start_ts: res.nap.start, end_ts: res.nap.end, category: 'sleep', label: 'nap', project_id: null,
        source: 'app', created_at: ts, updated_at: ts, deleted_at: null,
      }
      await outbox.enqueue('time_blocks', nap as unknown as Record<string, unknown>)
    }
    await outbox.enqueue('sleep', res.row as unknown as Record<string, unknown>)
  }
  return { action: res.action, message: bedMessage(res, p.tz) }
}

function bedMessage(res: ReturnType<typeof applyBedTap>, tzName: string): string {
  const t = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tzName })
  const row = res.row
  switch (res.action) {
    case 'bed': return row ? `In bed ${t(row.bed_ts)} (${row.late_min >= 0 ? '+' : ''}${row.late_min} min)` : 'In bed'
    case 'nap_then_bed': return row ? `Nap logged · in bed ${t(row.bed_ts)}` : 'In bed'
    case 'wake': return row?.wake_ts ? `Up ${t(row.wake_ts)}` : 'Up'
    case 'bed_duplicate': return 'Already in bed'
    case 'bed_ignored': return 'Bedtime already logged'
    case 'bed_daytime_ignored': return 'Daytime tap ignored'
    case 'wake_duplicate': return 'Already up'
  }
}

/** Close the open sleep row at `at` (default now). Returns false when there is nothing to close or it is < 3 h after bed. */
export async function wakeLocal(at: Date = new Date()): Promise<boolean> {
  const p = today.value
  if (!p) return false
  const closed = applyWake(openSleepRow(p, at), at, 'app')
  if (!closed) return false
  await outbox.enqueue('sleep', closed as unknown as Record<string, unknown>)
  return true
}

export async function saveCheckin(kind: 'morning' | 'evening', note: string): Promise<void> {
  const p = today.value
  const day = localDay(new Date(), p?.tz ?? settings.value.tz)
  const ts = nowIso()
  const cur: Checkin = p?.checkin && p.checkin.local_day === day
    ? p.checkin
    : { local_day: day, morning_at: null, morning_note: null, evening_at: null, evening_note: null, updated_at: ts, deleted_at: null }
  const row: Checkin = kind === 'morning'
    ? { ...cur, morning_at: ts, morning_note: note.trim(), updated_at: ts, deleted_at: null }
    : { ...cur, evening_at: ts, evening_note: note.trim(), updated_at: ts, deleted_at: null }
  await outbox.enqueue('checkins', row as unknown as Record<string, unknown>)
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const ts = nowIso()
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    await outbox.enqueue('settings', { key, value: JSON.stringify(value), updated_at: ts })
  }
  // The server's idea of today (and every local_day) depends on the settings, so refresh once the write lands.
  void outbox.flush().then(() => loadToday(), () => loadToday())
}

export async function saveRoutineItems(rows: RoutineItem[]): Promise<void> {
  const ts = nowIso()
  for (const r of rows) await outbox.enqueue('routine_items', { ...r, updated_at: ts } as unknown as Record<string, unknown>)
}

// ---- token -------------------------------------------------------------------------------------------

// A token arriving later (pasted in Settings, or restored from IndexedDB after localStorage was evicted) unblocks
// everything: push what is queued and load today. Skips the initial value so start-up does not load twice.
let seenToken = token.value
effect(() => {
  const t = token.value
  if (t && t !== seenToken) { void outbox.flush(); void loadToday() }
  seenToken = t
})

// ---- clock -------------------------------------------------------------------------------------------

let clockStarted = false
export function startClock(): void {
  if (clockStarted) return
  clockStarted = true
  setInterval(() => { now.value = new Date() }, 30_000)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { now.value = new Date(); void loadToday() }
  })
}
