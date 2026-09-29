// Mac-derived session suggestions (GET /api/work/suggestions): one state signal per local day, network-first with
// the IndexedDB copy as fallback, re-fetched on visibilitychange and after an outbox flush that touched sessions or
// time_blocks (either changes which minutes are free). Dismissals live in localStorage keyed by start|end (pruned
// to the last week, every access in try/catch); accepting one queues a finished session row with source 'suggest'
// through data/work.ts and hides the suggestion at once, before the server confirms. The pure helpers (keys,
// labels, pruning, edited spans) are unit-tested in test/app-suggest.test.ts.
import { effect, signal, type Signal } from '@preact/signals'
import { zonedToUTC } from '@shared/tz'
import { ApiError, apiGet, hasToken, readCache, token } from './api'
import * as outbox from './outbox'
import { durationLabel, hhmm } from './format'
import { addSpanSession, projectName, type SessionRow } from './work'

export interface SuggestedApp { app_id: string; label: string; minutes: number }
export interface Suggestion { start: string; end: string; minutes: number; top_apps: SuggestedApp[] }
export interface SuggestProject { id: string; name: string; color: string | null }
export interface SuggestionsPayload {
  day: string
  suggestions: Suggestion[]
  projects: SuggestProject[]
  last_project_id: string | null
}
export interface SuggestState {
  day: string
  data: SuggestionsPayload | null
  loading: boolean
  error: string | null
  fetchedAt: string | null
  cached: boolean
}
export interface AcceptSpan { start: string; end: string }

export const DISMISSED_KEY = 'planner.suggest.dismissed'
export const DISMISSED_KEEP_DAYS = 7
export const DISMISSED_MAX = 200
/** How many of today's suggestions the Today card shows. */
export const TODAY_MAX = 2

const HHMM = /^\d{2}:\d{2}$/
const states = new Map<string, Signal<SuggestState>>()
const inflight = new Map<string, Promise<void>>()
const watchers = new Map<string, number>()
const cacheKey = (day: string) => `suggest:${day}`

/** Keys (start|end) of suggestions the user dismissed or logged, so they never come back while the server catches up. */
export const hidden = signal<ReadonlySet<string>>(new Set(readDismissed()))

// ---- pure helpers ---------------------------------------------------------------------------------------

export function suggestionKey(s: Pick<Suggestion, 'start' | 'end'>): string {
  return `${s.start}|${s.end}`
}
/** "09:10–10:40" in tz. */
export function spanLabel(s: Pick<Suggestion, 'start' | 'end'>, tz: string): string {
  return `${hhmm(s.start, tz)}–${hhmm(s.end, tz)}`
}
/** "VS Code, Terminal" (top apps in order), '' when none. */
export function appsLabel(s: Pick<Suggestion, 'top_apps'>): string {
  return s.top_apps.map((a) => a.label).join(', ')
}
/** "Mac dev time 09:10–10:40 · 1h30 · VS Code, Terminal" */
export function suggestionLabel(s: Suggestion, tz: string): string {
  const apps = appsLabel(s)
  return `Mac dev time ${spanLabel(s, tz)} · ${durationLabel(s.minutes)}${apps ? ` · ${apps}` : ''}`
}
/** Keys whose start is older than keepDays go; at most `max` (the newest) are kept. */
export function pruneDismissed(keys: readonly string[], now: Date, keepDays = DISMISSED_KEEP_DAYS, max = DISMISSED_MAX): string[] {
  const cutoff = now.getTime() - keepDays * 86400_000
  const kept = keys.filter((k) => {
    const t = new Date(k.split('|')[0] ?? '').getTime()
    return Number.isFinite(t) && t >= cutoff
  })
  return kept.slice(-max)
}
/** Edited 'HH:MM' start/end on `day` -> ISO span; an end at or before the start rolls to the next day. */
export function editedSpan(day: string, start: string, end: string, tz: string): AcceptSpan | null {
  if (!HHMM.test(start) || !HHMM.test(end)) return null
  const s = zonedToUTC(day, start, tz)
  let e = zonedToUTC(day, end, tz)
  if (e.getTime() <= s.getTime()) e = new Date(e.getTime() + 86400_000)
  return { start: s.toISOString(), end: e.toISOString() }
}

// ---- state ---------------------------------------------------------------------------------------------

/** The state signal for a day (created empty on first use). */
export function suggestState(day: string): Signal<SuggestState> {
  let s = states.get(day)
  if (!s) {
    s = signal<SuggestState>({ day, data: null, loading: false, error: null, fetchedAt: null, cached: false })
    states.set(day, s)
  }
  return s
}

/** The day's suggestions minus the hidden ones, earliest first. */
export function visibleSuggestions(day: string): Suggestion[] {
  const data = suggestState(day).value.data
  if (!data) return []
  const h = hidden.value
  return data.suggestions.filter((s) => !h.has(suggestionKey(s)))
}

/** A project's name from any loaded payload, else the Work tab's list. */
function nameOf(projectId: string): string {
  for (const s of states.values()) {
    const p = s.value.data?.projects.find((x) => x.id === projectId)
    if (p) return p.name
  }
  return projectName(projectId)
}

// ---- loading -------------------------------------------------------------------------------------------

/** Fetch one day (cache fallback). Concurrent callers for the same day share one request. */
export function loadSuggestions(day: string): Promise<void> {
  const cur = inflight.get(day)
  if (cur) return cur
  const p = loadOnce(day).finally(() => { inflight.delete(day) })
  inflight.set(day, p)
  return p
}

async function loadOnce(day: string): Promise<void> {
  const s = suggestState(day)
  if (!hasToken()) {
    const hit = await readCache<SuggestionsPayload>(cacheKey(day))
    if (hit) apply(s, hit.data, hit.fetchedAt, true)
    return
  }
  s.value = { ...s.value, loading: true }
  try {
    const r = await apiGet<SuggestionsPayload>(`/api/work/suggestions?day=${encodeURIComponent(day)}`, cacheKey(day))
    apply(s, r.data, r.fetchedAt, r.cached)
    s.value = { ...s.value, error: null }
  } catch (err) {
    s.value = { ...s.value, error: err instanceof ApiError ? err.message : 'Cannot reach the server' }
    if (!s.value.data) {
      const hit = await readCache<SuggestionsPayload>(cacheKey(day))
      if (hit) apply(s, hit.data, hit.fetchedAt, true)
    }
  } finally {
    s.value = { ...s.value, loading: false }
  }
}

/** Apply a payload, never an older cached one over a newer one. */
function apply(s: Signal<SuggestState>, data: SuggestionsPayload, at: string, cached: boolean): void {
  const cur = s.value
  if (cached && cur.data && cur.fetchedAt && at <= cur.fetchedAt) return
  s.value = { ...cur, data, fetchedAt: at, cached }
}

function reloadWatched(): void {
  for (const day of watchers.keys()) void loadSuggestions(day)
}

outbox.onFlushed((items) => {
  if (items.some((it) => it.table === 'sessions' || it.table === 'time_blocks')) reloadWatched()
})

// A token that arrives after boot (pasted in Settings, restored from IndexedDB) fetches every watched day.
let seenToken: string | null = null
effect(() => {
  const t = token.value
  if (t && t !== seenToken) reloadWatched()
  seenToken = t
})

let wired = false
function wire(): void {
  if (wired || typeof document === 'undefined') return
  wired = true
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reloadWatched()
  })
}

/** Load `days` now and keep them fresh while a screen shows them. Returns the unwatch function (a useEffect cleanup). */
export function watchSuggestions(days: readonly string[]): () => void {
  for (const d of days) {
    watchers.set(d, (watchers.get(d) ?? 0) + 1)
    void loadSuggestions(d)
  }
  wire()
  return () => {
    for (const d of days) {
      const n = (watchers.get(d) ?? 1) - 1
      if (n <= 0) watchers.delete(d)
      else watchers.set(d, n)
    }
  }
}

// ---- dismiss / accept ------------------------------------------------------------------------------------

function readDismissed(): string[] {
  try {
    if (typeof localStorage === 'undefined') return []
    const raw = localStorage.getItem(DISMISSED_KEY)
    const arr: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? pruneDismissed(arr.filter((k): k is string => typeof k === 'string'), new Date()) : []
  } catch {
    return []
  }
}
function writeDismissed(keys: string[]): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(DISMISSED_KEY, JSON.stringify(keys))
  } catch { /* private mode, quota: the in-memory set still hides it for this visit */ }
}
function hide(key: string): void {
  const next = new Set(hidden.value)
  next.add(key)
  hidden.value = next
  writeDismissed(pruneDismissed([...readDismissed().filter((k) => k !== key), key], new Date()))
}

/** Hide a suggestion for good (this browser). */
export function dismissSuggestion(s: Pick<Suggestion, 'start' | 'end'>): void {
  hide(suggestionKey(s))
}

/**
 * Log a suggestion as a finished session on `projectId` (source 'suggest'), over its own span or an edited one,
 * through the outbox; the suggestion is hidden as soon as the row is queued.
 */
export async function acceptSuggestion(s: Suggestion, projectId: string, note?: string, span?: AcceptSpan): Promise<SessionRow> {
  const row = await addSpanSession({ id: projectId, name: nameOf(projectId) }, span?.start ?? s.start, span?.end ?? s.end, note ?? null, 'suggest')
  hide(suggestionKey(s))
  return row
}
