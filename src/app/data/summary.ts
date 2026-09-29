// Week / Month review data: /api/summary ranges (network-first, cached per range) and the pure math the views
// need — Mon-Sun weeks, per-category sums and averages, deltas vs the previous period, the "so far" comparison
// for the current week, bedtime stats and the labels. No DOM; unit-tested in test/app-summary.test.ts.
import { addDays, weekStart } from '@shared/tz'
import { apiGet, apiPost, type GetResult } from './api'

/** One day_summary row as /api/summary returns it (mirrors DaySummary in src/worker/rollup.ts). */
export interface DaySummary {
  local_day: string
  sleep_s: number
  workout_s: number
  study_s: number
  routine_s: number
  mac_s: number
  phone_s: number
  manual_s: number
  unknown_s: number
  tracked_s: number
  mac_by_category: Record<string, number>
  study_by_project: Record<string, number>
  manual_by_category: Record<string, number>
  kcal: number | null
  protein_g: number | null
  carb_g: number | null
  fat_g: number | null
  sets_count: number
  volume: number
  sessions_count: number
  routine_done: number
  routine_total: number
  bed_late_min: number | null
  final: number
  computed_at: string | null
  /** Today: computed on request, never stored. */
  live?: boolean
  /** A past day whose row is missing or still waiting for a rebuild (the view offers a refresh). */
  stale?: boolean
}
export interface SummaryProject { id: string; name: string; color: string | null }
export interface SummaryResponse { from: string; to: string; today: string; days: DaySummary[]; projects: SummaryProject[] }

// ---- loading ------------------------------------------------------------------------------------------

export function loadRange(from: string, to: string): Promise<GetResult<SummaryResponse>> {
  return apiGet<SummaryResponse>(`/api/summary?from=${from}&to=${to}`, `summary:${from}:${to}`)
}

/** POST /api/rollup for one stale day; the caller reloads its range afterwards. */
export function rollupDay(day: string): Promise<{ day: string; summary: DaySummary }> {
  return apiPost<{ day: string; summary: DaySummary }>('/api/rollup', { day })
}

// ---- periods ------------------------------------------------------------------------------------------

export interface Period { start: string; end: string; days: string[] }

/** The Mon-Sun week holding `day`. */
export function weekOf(day: string): Period {
  const start = weekStart(day)
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
  return { start, end: days[6] as string, days }
}

/** The calendar month holding `day`. */
export function monthOf(day: string): Period {
  const [y, m] = day.split('-').map(Number) as [number, number]
  const start = `${y}-${String(m).padStart(2, '0')}-01`
  const nextMonth = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`
  const end = addDays(nextMonth, -1)
  const days: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)
  return { start, end, days }
}

/** The month `n` months away from the one holding `day` (first of that month). */
export function shiftMonth(day: string, n: number): string {
  const [y, m] = day.split('-').map(Number) as [number, number]
  const idx = y * 12 + (m - 1) + n
  const ny = Math.floor(idx / 12)
  const nm = (idx % 12) + 1
  return `${ny}-${String(nm).padStart(2, '0')}-01`
}

/** Rows keyed by day, for quick lookups over a period. */
export function byDay(days: readonly DaySummary[]): Map<string, DaySummary> {
  return new Map(days.map((d) => [d.local_day, d]))
}

/** The rows of a period, in order, skipping days the server did not return (future days). */
export function pick(rows: ReadonlyMap<string, DaySummary>, days: readonly string[]): DaySummary[] {
  return days.map((d) => rows.get(d)).filter((d): d is DaySummary => !!d)
}

/** A day counts as "with data" when something was tracked (a missing or never-computed day has tracked_s = 0). */
export function hasData(d: DaySummary | undefined): boolean {
  return !!d && d.tracked_s > 0
}

// ---- sums -----------------------------------------------------------------------------------------------

export const SUM_CATEGORIES = ['sleep', 'workout', 'study', 'routine', 'mac', 'phone', 'other', 'unknown'] as const
export type SumCategory = (typeof SUM_CATEGORIES)[number]
export const SUM_LABELS: Record<SumCategory, string> = {
  sleep: 'Sleep', workout: 'Workout', study: 'Study', routine: 'Routine', mac: 'Mac', phone: 'Phone', other: 'Other', unknown: 'Unknown',
}
export type CategorySeconds = Record<SumCategory, number>

export function secondsOf(d: DaySummary): CategorySeconds {
  return {
    sleep: d.sleep_s, workout: d.workout_s, study: d.study_s, routine: d.routine_s,
    mac: d.mac_s, phone: d.phone_s, other: d.manual_s, unknown: d.unknown_s,
  }
}

export interface Sums {
  seconds: CategorySeconds
  tracked_s: number
  /** Days with tracked_s > 0 (averages divide by this). */
  days_with_data: number
  days: number
}

export function emptySeconds(): CategorySeconds {
  return { sleep: 0, workout: 0, study: 0, routine: 0, mac: 0, phone: 0, other: 0, unknown: 0 }
}

/** Per-category totals over a set of days; days without data are excluded from the averages. */
export function sumDays(days: readonly DaySummary[]): Sums {
  const seconds = emptySeconds()
  let tracked = 0
  let withData = 0
  for (const d of days) {
    if (!hasData(d)) continue
    withData++
    tracked += d.tracked_s
    const s = secondsOf(d)
    for (const k of SUM_CATEGORIES) seconds[k] += s[k]
  }
  return { seconds, tracked_s: tracked, days_with_data: withData, days: days.length }
}

/** Average seconds per day with data, 0 when there is none. */
export function avgPerDay(sums: Sums, k: SumCategory): number {
  return sums.days_with_data ? sums.seconds[k] / sums.days_with_data : 0
}

/** Per-category difference (seconds) between two periods. */
export function deltas(cur: Sums, prev: Sums): CategorySeconds {
  const out = emptySeconds()
  for (const k of SUM_CATEGORIES) out[k] = cur.seconds[k] - prev.seconds[k]
  return out
}

/** Share of tracked time (0..1) per category; empty (all zero) when nothing was tracked. */
export function shares(sums: Sums): CategorySeconds {
  const out = emptySeconds()
  if (sums.tracked_s <= 0) return out
  for (const k of SUM_CATEGORIES) out[k] = sums.seconds[k] / sums.tracked_s
  return out
}

/** Percentage-point change per category between two share maps. */
export function shareDeltas(cur: CategorySeconds, prev: CategorySeconds): CategorySeconds {
  const out = emptySeconds()
  for (const k of SUM_CATEGORIES) out[k] = (cur[k] - prev[k]) * 100
  return out
}

/** Unknown share of a day (1 = nothing tracked / no data). */
export function unknownShare(d: DaySummary | undefined): number {
  if (!d || d.tracked_s <= 0) return 1
  return Math.min(1, Math.max(0, d.unknown_s / d.tracked_s))
}

/**
 * The current week's "so far" comparison: Mon..today of this week against the same weekdays of last week.
 * `today` is the server's local day; both sides use only the days up to that weekday.
 */
export function soFar(rows: ReadonlyMap<string, DaySummary>, weekStartDay: string, today: string): { cur: Sums; prev: Sums; through: number } {
  const through = Math.max(0, Math.min(6, dayIndex(weekStartDay, today)))
  const curDays = Array.from({ length: through + 1 }, (_, i) => addDays(weekStartDay, i))
  const prevDays = curDays.map((d) => addDays(d, -7))
  return { cur: sumDays(pick(rows, curDays)), prev: sumDays(pick(rows, prevDays)), through }
}

/** 0-based offset of `day` from `start` (negative before it). */
export function dayIndex(start: string, day: string): number {
  const [y1, m1, d1] = start.split('-').map(Number) as [number, number, number]
  const [y2, m2, d2] = day.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400_000)
}

// ---- study / mac breakdowns ---------------------------------------------------------------------------------

export interface KeyedSeconds { key: string; seconds: number }

/** Merge one JSON map column over days, largest first. */
export function mergeMaps(days: readonly DaySummary[], column: 'study_by_project' | 'mac_by_category' | 'manual_by_category'): KeyedSeconds[] {
  const acc = new Map<string, number>()
  for (const d of days) for (const [k, v] of Object.entries(d[column] ?? {})) acc.set(k, (acc.get(k) ?? 0) + (Number(v) || 0))
  return [...acc.entries()].map(([key, seconds]) => ({ key, seconds })).filter((x) => x.seconds > 0).sort((a, b) => b.seconds - a.seconds)
}

// ---- bedtime ----------------------------------------------------------------------------------------------

export interface BedtimeStats {
  nights: number
  on_target: number
  /** Mean late minutes over the nights with a row (null without any). */
  avg_late: number | null
  /** Consecutive on-target nights ending with the most recent night that has a row. */
  streak: number
  /** Per day: late minutes or null (no bed tap recorded for that night). */
  points: { day: string; late: number | null }[]
}

/** Nights on target (late_min <= grace), average late minutes and the current streak, over the period's days in order. */
export function bedtimeStats(days: readonly string[], rows: ReadonlyMap<string, DaySummary>, grace: number): BedtimeStats {
  const points = days.map((day) => ({ day, late: rows.get(day)?.bed_late_min ?? null }))
  const nights = points.filter((p): p is { day: string; late: number } => p.late !== null)
  const onTarget = nights.filter((p) => p.late <= grace).length
  const avg = nights.length ? nights.reduce((a, p) => a + p.late, 0) / nights.length : null
  // Streak: walk back from the last night with a row; a night without a row (never in bed?) breaks it.
  let streak = 0
  let i = points.length - 1
  while (i >= 0 && points[i]?.late === null) i--
  for (; i >= 0; i--) {
    const late = points[i]?.late
    if (late === null || late === undefined || late > grace) break
    streak++
  }
  return { nights: nights.length, on_target: onTarget, avg_late: avg, streak, points }
}

// ---- food / routine --------------------------------------------------------------------------------------------

/** Average kcal over the days with food logged (null when none). */
export function kcalAverage(days: readonly DaySummary[]): { avg: number | null; days: number } {
  const logged = days.filter((d) => d.kcal !== null && d.kcal !== undefined)
  if (!logged.length) return { avg: null, days: 0 }
  return { avg: logged.reduce((a, d) => a + (d.kcal ?? 0), 0) / logged.length, days: logged.length }
}

/** Routine completion over the period: done/total summed, plus per-day pairs. */
export function routineCompletion(days: readonly string[], rows: ReadonlyMap<string, DaySummary>): { done: number; total: number; per_day: { day: string; done: number; total: number }[] } {
  const perDay = days.map((day) => {
    const d = rows.get(day)
    const total = d?.routine_total ?? 0
    return { day, done: Math.min(total, d?.routine_done ?? 0), total }
  })
  return { done: perDay.reduce((a, p) => a + p.done, 0), total: perDay.reduce((a, p) => a + p.total, 0), per_day: perDay }
}

// ---- formatting ---------------------------------------------------------------------------------------------

/** "52h 10m" / "1h 05m" / "45m" / "2h" / "0m" from seconds (minutes padded once there are hours). */
export function fmtSeconds(sec: number): string {
  const m = Math.max(0, Math.round(sec / 60))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r}m`
  return r === 0 ? `${h}h` : `${h}h ${String(r).padStart(2, '0')}m`
}

/** "+1h 05m" / "−35m" / "±0" for a signed seconds difference (minute resolution). */
export function fmtDelta(sec: number): string {
  const m = Math.round(sec / 60)
  if (m === 0) return '±0'
  return `${m > 0 ? '+' : '−'}${fmtSeconds(Math.abs(m) * 60)}`
}

/** "+2.3" / "−0.8" / "±0" percentage points, one decimal (dropped when whole). */
export function fmtPoints(pp: number): string {
  const r = Math.round(pp * 10) / 10
  if (r === 0) return '±0'
  const body = Number.isInteger(r) ? String(Math.abs(r)) : Math.abs(r).toFixed(1)
  return `${r > 0 ? '+' : '−'}${body}`
}

/** "31%" of a 0..1 share. */
export function fmtPct(share: number): string {
  return `${Math.round(share * 100)}%`
}

/** "+20" / "−5" / "0" late minutes. */
export function fmtLate(min: number): string {
  const r = Math.round(min)
  return r > 0 ? `+${r}` : r < 0 ? `−${Math.abs(r)}` : '0'
}

/** "2,180" */
export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/** "22–28 Sep" or "29 Sep – 5 Oct" for a Mon-Sun week. */
export function weekLabel(p: Period): string {
  const [, m1, d1] = p.start.split('-').map(Number) as [number, number, number]
  const [, m2, d2] = p.end.split('-').map(Number) as [number, number, number]
  return m1 === m2 ? `${d1}–${d2} ${MONTHS[m1 - 1]}` : `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]}`
}

/** "September 2026" */
export function monthLabel(day: string): string {
  const [y, m] = day.split('-').map(Number) as [number, number]
  return `${MONTHS_LONG[m - 1]} ${y}`
}

/** "Sep" for a month, short. */
export function monthShort(day: string): string {
  const m = Number(day.split('-')[1])
  return MONTHS[m - 1] ?? ''
}

/** ISO week number of a local day (for the "Week 39" title). */
export function isoWeek(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, d))
  const dow = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - dow)
  const jan1 = Date.UTC(t.getUTCFullYear(), 0, 1)
  return Math.ceil(((t.getTime() - jan1) / 86400_000 + 1) / 7)
}
