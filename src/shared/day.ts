// buildDay: the 24-hour "where did my time go" timeline, computed from every source with a fixed precedence.
// Pure function: no I/O. Used by the Worker (GET /api/day, rollups) and by the app for optimistic rendering.
import type { AppCategoryRow, BlockCategory, FoodLog, RoutineItem, RoutineLog, Session, Sleep, TimeBlock, Workout } from './types'
import { dayWindow, localDay } from './tz'

export type ChartCategory =
  | 'unknown' | 'sleep' | 'workout' | 'study' | 'routine' | 'mac' | 'phone'
  | 'meal' | 'chores' | 'social' | 'commute' | 'rest' | 'other'

const CODE: Record<ChartCategory, number> = {
  unknown: 0, sleep: 1, workout: 2, study: 3, routine: 4, mac: 5, phone: 6,
  meal: 7, chores: 8, social: 9, commute: 10, rest: 11, other: 12,
}
const BY_CODE = Object.keys(CODE) as ChartCategory[]
export const MANUAL_CATEGORIES: ChartCategory[] = ['meal', 'chores', 'social', 'commute', 'rest', 'other']

export const OPEN_SLEEP_DRAW_MAX_MS = 14 * 3600_000
export const OPEN_SLEEP_GUESS_MS = 8 * 3600_000
export const OPEN_WORKOUT_MAX_MS = 3 * 3600_000
export const GAP_MIN_MINUTES = 5

export interface ScreenInterval { source: 'mac' | 'phone'; device: string; start_ts: string; end_ts: string; top_app: string | null }
export interface ScreenHour { source: 'mac' | 'phone'; device: string; hour_start: string; app_id: string; seconds: number }

export interface DayInput {
  day: string
  tz: string
  now: Date
  time_blocks: TimeBlock[]
  sleep: Sleep[]
  workouts: Workout[]
  sessions: (Session & { project_name?: string | null })[]
  routine_log: RoutineLog[]
  routine_items: RoutineItem[]
  screen_intervals: ScreenInterval[]
  screen_hours: ScreenHour[]
  app_categories: Pick<AppCategoryRow, 'app_id' | 'label' | 'category'>[]
  food_log?: Pick<FoodLog, 'ts' | 'label' | 'kcal' | 'slot'>[]
}

export interface Block {
  start: string
  end: string
  minutes: number
  category: ChartCategory
  sub: string | null      // project id, app category, routine item id
  label: string
  source: string          // manual | sleep | sleep? | workout | session | routine | mac | mac-hours | phone | unknown
}
export interface Gap { start: string; end: string; minutes: number }
export interface Totals {
  sleep_s: number; workout_s: number; study_s: number; routine_s: number; mac_s: number; phone_s: number
  manual_s: number; unknown_s: number; tracked_s: number
}
export interface DayResult {
  day: string
  tz: string
  start: string
  end: string
  minutes: number
  now_min: number
  is_today: boolean
  blocks: Block[]
  gaps: Gap[]
  totals: Totals
  mac_by_category: Record<string, number>
  study_by_project: Record<string, number>
  manual_by_category: Record<string, number>
  markers: { ts: string; label: string; kcal: number; slot: string }[]
  sleep_inferred: boolean
}

interface Cell { code: number; sub: string | null; label: string; source: string }

export function buildDay(input: DayInput): DayResult {
  const { day, tz, now } = input
  const win = dayWindow(day, tz)
  const N = win.minutes
  const startMs = win.start.getTime()
  const isToday = localDay(now, tz) === day
  const nowMin = isToday ? Math.max(0, Math.min(N, Math.floor((now.getTime() - startMs) / 60000))) : (now.getTime() < startMs ? 0 : N)

  const cells: (Cell | null)[] = new Array(N).fill(null)
  const msToMin = (ms: number) => (ms - startMs) / 60000

  function fill(start: string | Date, end: string | Date, category: ChartCategory, label: string, sub: string | null, source: string): void {
    const s0 = msToMin(new Date(start).getTime())
    const e0 = msToMin(new Date(end).getTime())
    const s = Math.max(0, Math.floor(s0))
    const e = Math.min(nowMin, Math.ceil(e0))
    if (e <= s) return
    const cell: Cell = { code: CODE[category], sub, label, source }
    for (let m = s; m < e; m++) if (cells[m] === null) cells[m] = cell
  }

  const byStart = <T>(arr: T[], key: (t: T) => string) => [...arr].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
  const live = <T extends { deleted_at: string | null }>(arr: T[]) => arr.filter((r) => !r.deleted_at)

  // 1. manual blocks always win
  for (const b of byStart(live(input.time_blocks), (b) => b.start_ts)) {
    const cat = b.category as ChartCategory
    fill(b.start_ts, b.end_ts, cat, b.label ?? titleCase(cat), b.project_id ?? null, 'manual')
  }

  // 2. sleep
  let sleepInferred = false
  for (const s of byStart(live(input.sleep), (s) => s.bed_ts)) {
    const bed = new Date(s.bed_ts).getTime()
    if (s.wake_ts) {
      fill(s.bed_ts, s.wake_ts, 'sleep', 'Sleep', null, 'sleep')
    } else if (now.getTime() - bed <= OPEN_SLEEP_DRAW_MAX_MS) {
      fill(s.bed_ts, now, 'sleep', 'Sleep', null, 'sleep')
    } else {
      sleepInferred = true
      fill(s.bed_ts, new Date(bed + OPEN_SLEEP_GUESS_MS), 'sleep', 'Sleep?', null, 'sleep?')
    }
  }

  // 3. workouts
  for (const w of byStart(live(input.workouts), (w) => w.started_at)) {
    const st = new Date(w.started_at).getTime()
    const end = w.ended_at ?? new Date(Math.min(now.getTime(), st + OPEN_WORKOUT_MAX_MS)).toISOString()
    fill(w.started_at, end, 'workout', w.name ?? 'Workout', w.id, 'workout')
  }

  // 4. study / project sessions
  for (const s of byStart(live(input.sessions), (s) => s.started_at)) {
    const end = s.ended_at ?? now.toISOString()
    fill(s.started_at, end, 'study', s.project_name ?? 'Session', s.project_id, 'session')
  }

  // 5. routine taps: started -> ended (or default minutes)
  const items = new Map(input.routine_items.map((i) => [i.id, i]))
  for (const r of byStart(live(input.routine_log), (r) => r.started_at)) {
    const item = items.get(r.item_id)
    const defMin = item?.default_min ?? 10
    const end = r.ended_at ?? new Date(new Date(r.started_at).getTime() + defMin * 60000).toISOString()
    const cat: ChartCategory = item?.chart_category === 'workout' ? 'workout' : 'routine'
    fill(r.started_at, end, cat, item?.name ?? r.item_id, r.item_id, 'routine')
  }

  // 6. Mac focus intervals (precise placement)
  const appCat = new Map(input.app_categories.map((a) => [a.app_id, a]))
  const catOf = (app: string | null) => (app && appCat.get(app)?.category) || 'other'
  const labelOf = (app: string | null) => (app && (appCat.get(app)?.label || shortBundle(app))) || 'Mac'
  for (const iv of byStart(input.screen_intervals.filter((i) => i.source === 'mac'), (i) => i.start_ts)) {
    fill(iv.start_ts, iv.end_ts, 'mac', labelOf(iv.top_app), catOf(iv.top_app), 'mac')
  }

  // 7. Mac hours without interval coverage: walk from the hour start
  const hourGroups = groupHours(input.screen_hours.filter((h) => h.source === 'mac'))
  for (const [hourStart, rows] of hourGroups) {
    const hs = Math.floor(msToMin(new Date(hourStart).getTime()))
    if (hs >= N || hs + 60 <= 0) continue
    const total = Math.min(3600, rows.reduce((a, r) => a + r.seconds, 0))
    let need = Math.min(60, Math.round(total / 60))
    // subtract minutes already tinted as mac in this hour
    for (let m = Math.max(0, hs); m < Math.min(N, hs + 60); m++) if (cells[m]?.code === CODE.mac) need--
    if (need <= 0) continue
    const top = [...rows].sort((a, b) => b.seconds - a.seconds)[0]
    const cell: Cell = { code: CODE.mac, sub: catOf(top?.app_id ?? null), label: labelOf(top?.app_id ?? null), source: 'mac-hours' }
    for (let m = Math.max(0, hs); m < Math.min(nowMin, hs + 60) && need > 0; m++) {
      if (cells[m] === null) { cells[m] = cell; need-- }
    }
  }

  // 8. phone hours take what is left of each hour
  const phoneGroups = groupHours(input.screen_hours.filter((h) => h.source === 'phone'))
  for (const [hourStart, rows] of phoneGroups) {
    const hs = Math.floor(msToMin(new Date(hourStart).getTime()))
    if (hs >= N || hs + 60 <= 0) continue
    const totalRows = rows.filter((r) => r.app_id === '_total')
    const total = Math.min(3600, (totalRows.length ? totalRows : rows).reduce((a, r) => a + r.seconds, 0))
    let need = Math.min(60, Math.round(total / 60))
    for (let m = Math.max(0, hs); m < Math.min(N, hs + 60); m++) if (cells[m]?.code === CODE.phone) need--
    const cell: Cell = { code: CODE.phone, sub: null, label: 'Phone', source: 'phone' }
    for (let m = Math.max(0, hs); m < Math.min(nowMin, hs + 60) && need > 0; m++) {
      if (cells[m] === null) { cells[m] = cell; need-- }
    }
  }

  // ---- totals from cells (before display absorption)
  const totals: Totals = { sleep_s: 0, workout_s: 0, study_s: 0, routine_s: 0, mac_s: 0, phone_s: 0, manual_s: 0, unknown_s: 0, tracked_s: nowMin * 60 }
  const manualBy: Record<string, number> = {}
  for (let m = 0; m < nowMin; m++) {
    const c = cells[m]
    if (!c) { totals.unknown_s += 60; continue }
    switch (c.code) {
      case CODE.sleep: totals.sleep_s += 60; break
      case CODE.workout: totals.workout_s += 60; break
      case CODE.study: totals.study_s += 60; break
      case CODE.routine: totals.routine_s += 60; break
      case CODE.mac: totals.mac_s += 60; break
      case CODE.phone: totals.phone_s += 60; break
      default: {
        totals.manual_s += 60
        const k = BY_CODE[c.code] ?? 'other'
        manualBy[k] = (manualBy[k] ?? 0) + 60
      }
    }
  }

  // ---- run-length encode into blocks
  const iso = (m: number) => new Date(startMs + m * 60000).toISOString()
  const blocks: Block[] = []
  let runStart = 0
  const same = (a: Cell | null, b: Cell | null) => (a === null && b === null) || (a !== null && b !== null && a.code === b.code && a.sub === b.sub && a.label === b.label && a.source === b.source)
  for (let m = 1; m <= nowMin; m++) {
    if (m === nowMin || !same(cells[m] ?? null, cells[runStart] ?? null)) {
      const c = cells[runStart] ?? null
      blocks.push({
        start: iso(runStart), end: iso(m), minutes: m - runStart,
        category: c ? (BY_CODE[c.code] ?? 'other') : 'unknown', sub: c?.sub ?? null,
        label: c?.label ?? 'Unknown', source: c?.source ?? 'unknown',
      })
      runStart = m
    }
  }

  // absorb tiny unknown runs into the previous block (display only)
  const display: Block[] = []
  const sameBlock = (a: Block, b: Block) => a.category === b.category && a.sub === b.sub && a.label === b.label && a.source === b.source
  for (const b of blocks) {
    const prev = display[display.length - 1]
    if (prev && ((b.category === 'unknown' && b.minutes < GAP_MIN_MINUTES) || sameBlock(prev, b))) {
      prev.end = b.end
      prev.minutes += b.minutes
    } else display.push({ ...b })
  }
  const gaps: Gap[] = display.filter((b) => b.category === 'unknown').map((b) => ({ start: b.start, end: b.end, minutes: b.minutes }))

  // ---- raw-seconds breakdowns (never from tinted cells)
  const winStartIso = win.start.toISOString(), winEndIso = win.end.toISOString()
  const macBy: Record<string, number> = {}
  for (const h of input.screen_hours) {
    if (h.source !== 'mac' || h.hour_start < winStartIso || h.hour_start >= winEndIso) continue
    const k = catOf(h.app_id)
    macBy[k] = (macBy[k] ?? 0) + h.seconds
  }
  const studyBy: Record<string, number> = {}
  for (const s of live(input.sessions)) {
    const st = Math.max(new Date(s.started_at).getTime(), startMs)
    const en = Math.min(new Date(s.ended_at ?? now).getTime(), win.end.getTime(), isToday ? now.getTime() : Infinity)
    if (en > st) studyBy[s.project_id] = (studyBy[s.project_id] ?? 0) + Math.round((en - st) / 1000)
  }

  const markers = (input.food_log ?? [])
    .filter((f) => f.ts >= winStartIso && f.ts < winEndIso)
    .map((f) => ({ ts: f.ts, label: f.label, kcal: f.kcal, slot: f.slot }))
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))

  return {
    day, tz, start: winStartIso, end: winEndIso, minutes: N, now_min: nowMin, is_today: isToday,
    blocks: display, gaps, totals, mac_by_category: macBy, study_by_project: studyBy, manual_by_category: manualBy,
    markers, sleep_inferred: sleepInferred,
  }
}

function groupHours(rows: ScreenHour[]): Map<string, ScreenHour[]> {
  const m = new Map<string, ScreenHour[]>()
  for (const r of rows) {
    const list = m.get(r.hour_start)
    if (list) list.push(r); else m.set(r.hour_start, [r])
  }
  return new Map([...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
}

export function shortBundle(bundle: string): string {
  const last = bundle.split('.').pop() ?? bundle
  return last.replace(/[-_]/g, ' ')
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export const CATEGORY_COLORS: Record<ChartCategory, string> = {
  unknown: '#64748b', sleep: '#6366f1', workout: '#f97316', study: '#0ea5e9', routine: '#22c55e', mac: '#a855f7', phone: '#ec4899',
  meal: '#eab308', chores: '#14b8a6', social: '#f43f5e', commute: '#78716c', rest: '#8b5cf6', other: '#94a3b8',
}
export const CATEGORY_LABELS: Record<ChartCategory, string> = {
  unknown: 'Unknown', sleep: 'Sleep', workout: 'Workout', study: 'Study / projects', routine: 'Routine', mac: 'Mac', phone: 'Phone',
  meal: 'Meals', chores: 'Chores', social: 'Social', commute: 'Commute', rest: 'Rest', other: 'Other',
}
