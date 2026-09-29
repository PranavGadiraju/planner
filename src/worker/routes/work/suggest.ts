// Mac-derived session suggestions: "Log 09:10–10:40 as planner?" — study or project time the user forgot to start,
// found in the Mac screen time as runs of dev/work apps that no session, workout, manual block or sleep row already
// claims. Pure (no D1, no Worker globals) so vitest covers it in test/worker-suggest.test.ts; the handler in
// ./suggestions.ts loads the same DayInput as GET /api/day and hands it here.
//
// One pass over the day's minute grid, like buildDay (O(minutes), deterministic):
//   1. taken[m]   = a live session, workout, time_block or sleep row covers minute m (same open-row rules as buildDay)
//   2. dev[m]     = the app behind minute m when it is a dev/work app: the top_app of a Mac screen interval whose
//                   category is in `categories`, else the buildDay layer-7 walk of screen_hours for hours the
//                   intervals do not cover (counting only apps in those categories)
//   3. a window of `windowMin` minutes slides over [0, now) in steps of `stepMin`; it qualifies when >= needMin of
//      its minutes are dev and none is taken; qualifying windows are unioned into ranges, each range is trimmed to
//      its dev minutes at both ends, and ranges shorter than minBlockMin are dropped
//   4. each range lists its top 3 apps by minutes inside it
import type { DayInput, ScreenHour } from '../../../shared/day'
import { OPEN_SLEEP_DRAW_MAX_MS, OPEN_SLEEP_GUESS_MS, OPEN_WORKOUT_MAX_MS, shortBundle } from '../../../shared/day'
import { dayWindow, localDay } from '../../../shared/tz'

export interface SuggestOptions {
  /** app_categories.category values that count as focused work (default dev + work). */
  categories?: readonly string[]
  /** Sliding window length in minutes (default 30). */
  windowMin?: number
  /** Dev minutes a window needs to qualify (default 25). */
  needMin?: number
  /** Ranges shorter than this are dropped (default 30). */
  minBlockMin?: number
  /** Window step in minutes (default 5). */
  stepMin?: number
  /** Defaults to input.now. */
  now?: Date
}
export interface SuggestedApp { app_id: string; label: string; minutes: number }
export interface Suggestion { start: string; end: string; minutes: number; top_apps: SuggestedApp[] }

export const DEFAULT_CATEGORIES: readonly string[] = ['dev', 'work']
export const WINDOW_MIN = 30
export const NEED_MIN = 25
export const MIN_BLOCK_MIN = 30
export const STEP_MIN = 5
export const TOP_APPS = 3

export function suggestSessions(input: DayInput, opts: SuggestOptions = {}): Suggestion[] {
  const categories = new Set(opts.categories ?? DEFAULT_CATEGORIES)
  const W = Math.max(1, Math.round(opts.windowMin ?? WINDOW_MIN))
  const needMin = Math.max(1, Math.min(W, Math.round(opts.needMin ?? NEED_MIN)))
  const minBlock = Math.max(1, Math.round(opts.minBlockMin ?? MIN_BLOCK_MIN))
  const step = Math.max(1, Math.round(opts.stepMin ?? STEP_MIN))
  const now = opts.now ?? input.now
  const { day, tz } = input
  const win = dayWindow(day, tz)
  const N = win.minutes
  const startMs = win.start.getTime()
  const isToday = localDay(now, tz) === day
  const nowMin = isToday ? Math.max(0, Math.min(N, Math.floor((now.getTime() - startMs) / 60000))) : now.getTime() < startMs ? 0 : N
  if (nowMin < W) return []

  const msToMin = (ms: number) => (ms - startMs) / 60000
  /** [start, end) of an instant range on the minute grid, clipped to the day and to now. */
  const span = (start: string | Date, end: string | Date): [number, number] => [
    Math.max(0, Math.floor(msToMin(new Date(start).getTime()))),
    Math.min(nowMin, Math.ceil(msToMin(new Date(end).getTime()))),
  ]
  const live = <T extends { deleted_at: string | null }>(arr: readonly T[]) => arr.filter((r) => !r.deleted_at)

  // 1. minutes another source already claims
  const taken = new Uint8Array(N)
  const claim = (start: string | Date, end: string | Date): void => {
    const [s, e] = span(start, end)
    for (let m = s; m < e; m++) taken[m] = 1
  }
  for (const b of live(input.time_blocks)) claim(b.start_ts, b.end_ts)
  for (const s of live(input.sleep)) {
    const bed = new Date(s.bed_ts).getTime()
    if (s.wake_ts) claim(s.bed_ts, s.wake_ts)
    else if (now.getTime() - bed <= OPEN_SLEEP_DRAW_MAX_MS) claim(s.bed_ts, now)
    else claim(s.bed_ts, new Date(bed + OPEN_SLEEP_GUESS_MS))
  }
  for (const w of live(input.workouts)) {
    const st = new Date(w.started_at).getTime()
    claim(w.started_at, w.ended_at ?? new Date(Math.min(now.getTime(), st + OPEN_WORKOUT_MAX_MS)))
  }
  for (const s of live(input.sessions)) claim(s.started_at, s.ended_at ?? now)

  // 2. minutes in a dev/work app: dev[m] indexes `apps` (-1 = none); covered[m] = any Mac interval, whatever its app
  const appCat = new Map(input.app_categories.map((a) => [a.app_id, a]))
  const isDev = (app: string | null | undefined): app is string => !!app && categories.has(appCat.get(app)?.category ?? '')
  const apps: string[] = []
  const index = new Map<string, number>()
  const idx = (app: string): number => {
    let i = index.get(app)
    if (i === undefined) {
      i = apps.length
      apps.push(app)
      index.set(app, i)
    }
    return i
  }
  const dev = new Int32Array(N).fill(-1)
  const devAt = (m: number): number => dev[m] ?? -1
  const covered = new Uint8Array(N)
  const intervals = input.screen_intervals
    .filter((i) => i.source === 'mac')
    .sort((a, b) => (a.start_ts < b.start_ts ? -1 : a.start_ts > b.start_ts ? 1 : 0))
  for (const iv of intervals) {
    const [s, e] = span(iv.start_ts, iv.end_ts)
    const app = isDev(iv.top_app) ? idx(iv.top_app) : -1
    for (let m = s; m < e; m++) {
      if (covered[m]) continue // the earlier-starting interval wins, as in buildDay
      covered[m] = 1
      if (app >= 0) dev[m] = app
    }
  }
  // hours without interval coverage: walk from the hour start, dev/work apps only, into minutes nothing else holds
  for (const [hourStart, rows] of groupHours(input.screen_hours.filter((h) => h.source === 'mac' && isDev(h.app_id)))) {
    const hs = Math.floor(msToMin(new Date(hourStart).getTime()))
    if (hs >= N || hs + 60 <= 0) continue
    const total = Math.min(3600, rows.reduce((a, r) => a + r.seconds, 0))
    let need = Math.min(60, Math.round(total / 60))
    for (let m = Math.max(0, hs); m < Math.min(N, hs + 60); m++) if (devAt(m) >= 0) need--
    if (need <= 0) continue
    const top = [...rows].sort((a, b) => b.seconds - a.seconds || (a.app_id < b.app_id ? -1 : 1))[0]
    if (!top) continue
    const app = idx(top.app_id)
    for (let m = Math.max(0, hs); m < Math.min(nowMin, hs + 60) && need > 0; m++) {
      if (covered[m] || taken[m] || devAt(m) >= 0) continue
      dev[m] = app
      need--
    }
  }

  // 3. sliding windows over prefix sums; qualifying windows are unioned through a difference array
  const devPre = new Int32Array(N + 1)
  const takenPre = new Int32Array(N + 1)
  for (let m = 0; m < N; m++) {
    devPre[m + 1] = (devPre[m] ?? 0) + (devAt(m) >= 0 ? 1 : 0)
    takenPre[m + 1] = (takenPre[m] ?? 0) + (taken[m] ?? 0)
  }
  const diff = new Int32Array(N + 1)
  for (let w = 0; w + W <= nowMin; w += step) {
    const d = (devPre[w + W] ?? 0) - (devPre[w] ?? 0)
    const t = (takenPre[w + W] ?? 0) - (takenPre[w] ?? 0)
    if (d >= needMin && t === 0) {
      diff[w] = (diff[w] ?? 0) + 1
      diff[w + W] = (diff[w + W] ?? 0) - 1
    }
  }

  // 4. ranges -> suggestions (trimmed to dev minutes, minimum length, top apps)
  const iso = (m: number) => new Date(startMs + m * 60000).toISOString()
  const out: Suggestion[] = []
  const emit = (s0: number, e0: number): void => {
    let s = s0
    let e = e0
    while (s < e && devAt(s) < 0) s++
    while (e > s && devAt(e - 1) < 0) e--
    if (e - s < minBlock) return
    const count = new Map<number, number>()
    for (let m = s; m < e; m++) {
      const a = devAt(m)
      if (a >= 0) count.set(a, (count.get(a) ?? 0) + 1)
    }
    const top_apps = [...count.entries()]
      .sort((x, y) => y[1] - x[1] || x[0] - y[0])
      .slice(0, TOP_APPS)
      .map(([i, minutes]) => {
        const app_id = apps[i] ?? ''
        return { app_id, label: appCat.get(app_id)?.label || shortBundle(app_id), minutes }
      })
    out.push({ start: iso(s), end: iso(e), minutes: e - s, top_apps })
  }
  let depth = 0
  let runStart = -1
  for (let m = 0; m <= nowMin; m++) {
    depth += diff[m] ?? 0
    const inRange = m < nowMin && depth > 0
    if (inRange && runStart < 0) runStart = m
    else if (!inRange && runStart >= 0) {
      emit(runStart, m)
      runStart = -1
    }
  }
  return out
}

function groupHours(rows: ScreenHour[]): Map<string, ScreenHour[]> {
  const m = new Map<string, ScreenHour[]>()
  for (const r of rows) {
    const list = m.get(r.hour_start)
    if (list) list.push(r)
    else m.set(r.hour_start, [r])
  }
  return new Map([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}
