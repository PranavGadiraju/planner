// Pure helpers for the Day screen and the Today ring: minute math on a DayResult, the per-hour dominant category,
// the category strip, and the optimistic patch that writes a manual block into (or out of) a DayResult without
// re-running buildDay (the API returns only the result, never its inputs). No DOM; unit-tested in test/app-day.test.ts.
import type { Block, ChartCategory, DayResult, Gap, Totals } from '@shared/day'
import { GAP_MIN_MINUTES } from '@shared/day'
import type { BlockCategory, TimeBlock } from '@shared/types'
import { addDays, localDay } from '@shared/tz'

export const HOUR_COUNT = 24

/** Minute offset of an instant from the day's start (rounded; may fall outside [0, minutes]). */
export function minuteOf(ts: string | Date, dayStart: string): number {
  return Math.round((new Date(ts).getTime() - new Date(dayStart).getTime()) / 60000)
}

/** "9h 40m" / "45m" / "2h": strip, ring and sheet labels. */
export function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h === 0) return `${r}m`
  return r === 0 ? `${h}h` : `${h}h ${r}m`
}

export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---- colours ----------------------------------------------------------------------------------------

const MAC_TINT: Record<string, string> = {
  dev: 'var(--cat-mac)',
  work: 'color-mix(in srgb, var(--cat-mac) 78%, #fff)',
  comms: 'color-mix(in srgb, var(--cat-mac) 60%, #fff)',
  browsing: 'color-mix(in srgb, var(--cat-mac) 46%, #fff)',
  media: 'color-mix(in srgb, var(--cat-mac) 78%, #000)',
  social: 'color-mix(in srgb, var(--cat-mac) 60%, #000)',
  other: 'color-mix(in srgb, var(--cat-mac) 50%, var(--cat-other))',
}

/** CSS colour for a block: the --cat-* token, with Mac blocks tinted by their app category. */
export function blockColor(category: ChartCategory | 'other', sub: string | null): string {
  if (category === 'mac') return sub ? (MAC_TINT[sub] ?? MAC_TINT.other ?? 'var(--cat-mac)') : 'var(--cat-mac)'
  return `var(--cat-${category})`
}

// ---- strip + ring ------------------------------------------------------------------------------------

/** Strip order: rest first, screens, then whatever was typed by hand, Unknown last. */
export const STRIP_ORDER = ['sleep', 'workout', 'study', 'routine', 'mac', 'phone', 'other', 'unknown'] as const
export type StripCategory = (typeof STRIP_ORDER)[number]
export const SHORT_LABELS: Record<StripCategory, string> = {
  sleep: 'Sleep', workout: 'Workout', study: 'Study', routine: 'Routine', mac: 'Mac', phone: 'Phone', other: 'Other', unknown: 'Unknown',
}
export interface StripSegment { category: StripCategory; minutes: number; share: number }

/** Non-empty totals as ordered strip segments; shares sum to 1 over the elapsed part of the day. */
export function stripSegments(t: Totals): StripSegment[] {
  const secs: Record<StripCategory, number> = {
    sleep: t.sleep_s, workout: t.workout_s, study: t.study_s, routine: t.routine_s, mac: t.mac_s, phone: t.phone_s, other: t.manual_s, unknown: t.unknown_s,
  }
  const total = STRIP_ORDER.reduce((a, k) => a + secs[k], 0)
  return STRIP_ORDER.filter((k) => secs[k] > 0).map((k) => ({ category: k, minutes: Math.round(secs[k] / 60), share: total > 0 ? secs[k] / total : 0 }))
}

/** Minutes known vs unknown so far ("tracked 9h 40m · unknown 1h 10m"). */
export function ringSummary(t: Totals): { known: number; unknown: number } {
  return { known: Math.max(0, t.tracked_s - t.unknown_s) / 60, unknown: t.unknown_s / 60 }
}

/**
 * The category with the most minutes in each of the 24 hours (ties go to the earlier block); null for hours
 * with nothing tracked yet (still in the future on today). Extra DST minutes past hour 23 are ignored.
 */
export function hourDominant(r: Pick<DayResult, 'start' | 'blocks'>): (ChartCategory | null)[] {
  const counts: Map<ChartCategory, number>[] = Array.from({ length: HOUR_COUNT }, () => new Map())
  for (const b of r.blocks) {
    const s = Math.max(0, minuteOf(b.start, r.start))
    const e = s + b.minutes
    for (let h = Math.floor(s / 60); h * 60 < e && h < HOUR_COUNT; h++) {
      const overlap = Math.min(e, (h + 1) * 60) - Math.max(s, h * 60)
      const m = counts[h]
      if (overlap <= 0 || !m) continue
      m.set(b.category, (m.get(b.category) ?? 0) + overlap)
    }
  }
  return counts.map((m) => {
    let best: ChartCategory | null = null
    let bestN = 0
    for (const [c, n] of m) if (n > bestN) { best = c; bestN = n }
    return best
  })
}

// ---- gap helpers ---------------------------------------------------------------------------------------

/** The tracked blocks on either side of a gap, for "Same as previous / next block". */
export function gapNeighbours(r: Pick<DayResult, 'blocks'>, gap: Pick<Gap, 'start'>): { prev: Block | null; next: Block | null } {
  const i = r.blocks.findIndex((b) => b.category === 'unknown' && b.start === gap.start)
  if (i < 0) return { prev: null, next: null }
  const known = (b: Block | undefined) => (b && b.category !== 'unknown' ? b : null)
  return { prev: known(r.blocks[i - 1]), next: known(r.blocks[i + 1]) }
}

/** Manual category to use when copying a neighbour: Mac time becomes "other" (there is no manual Mac category). */
export function toBlockCategory(c: ChartCategory): BlockCategory {
  return c === 'mac' || c === 'unknown' ? 'other' : c
}

/**
 * The project of the study block closest to [start, end) (0 when they overlap, else the distance between the
 * nearest edges; ties go to the earlier block): the Fill sheet's default project for a study gap. Null when the
 * day has no study block with a project.
 */
export function nearestStudyProject(r: Pick<DayResult, 'blocks'>, start: string, end: string): string | null {
  const s0 = new Date(start).getTime()
  const e0 = new Date(end).getTime()
  let best: string | null = null
  let bestD = Infinity
  for (const b of r.blocks) {
    if (b.category !== 'study' || !b.sub) continue
    const s = new Date(b.start).getTime()
    const e = new Date(b.end).getTime()
    const d = Math.max(0, s - e0, s0 - e)
    if (d < bestD) { bestD = d; best = b.sub }
  }
  return best
}

// ---- top Mac apps inside a block ------------------------------------------------------------------------

export interface BlockApp { label: string; seconds: number }

/**
 * The top Mac apps the Worker attaches to a study block (`Block.apps`, present once the shared type carries it).
 * Read defensively: an older cached payload or an optimistic patch has none.
 */
export function blockApps(b: Block): BlockApp[] {
  const raw = (b as Block & { apps?: unknown }).apps
  if (!Array.isArray(raw)) return []
  const out: BlockApp[] = []
  for (const a of raw as unknown[]) {
    if (!a || typeof a !== 'object') continue
    const { label, seconds } = a as { label?: unknown; seconds?: unknown }
    if (typeof label === 'string' && label && typeof seconds === 'number' && seconds > 0) out.push({ label, seconds })
  }
  return out
}

// ---- optimistic patch ----------------------------------------------------------------------------------

type Cell = { category: ChartCategory; sub: string | null; label: string; source: string } | null

function sameCell(a: Cell, b: Cell): boolean {
  return (a === null && b === null) || (a !== null && b !== null && a.category === b.category && a.sub === b.sub && a.label === b.label && a.source === b.source)
}
function sameBlock(a: Block, b: Block): boolean {
  return a.category === b.category && a.sub === b.sub && a.label === b.label && a.source === b.source
}

function totalsKey(c: ChartCategory): keyof Totals | null {
  switch (c) {
    case 'sleep': return 'sleep_s'
    case 'workout': return 'workout_s'
    case 'study': return 'study_s'
    case 'routine': return 'routine_s'
    case 'mac': return 'mac_s'
    case 'phone': return 'phone_s'
    case 'unknown': return 'unknown_s'
    default: return null // manual categories: manual_s + manual_by_category
  }
}

/**
 * Replace the minutes [startTs, endTs) of a result with one cell (null = Unknown), mirroring buildDay's clipping
 * (floor the start, ceil the end, never past now). Blocks, gaps and totals are recomputed; the raw-seconds
 * breakdowns (mac_by_category, study_by_project) are left alone since they never come from cells.
 */
export function applyRange(r: DayResult, startTs: string, endTs: string, cell: Cell): DayResult {
  const startMs = new Date(r.start).getTime()
  const s = Math.max(0, Math.floor((new Date(startTs).getTime() - startMs) / 60000))
  const e = Math.min(r.now_min, Math.ceil((new Date(endTs).getTime() - startMs) / 60000))
  if (e <= s) return r

  // 1. cells from the display blocks
  const cells: Cell[] = new Array<Cell>(r.now_min).fill(null)
  for (const b of r.blocks) {
    if (b.category === 'unknown') continue
    const bs = Math.max(0, minuteOf(b.start, r.start))
    const be = Math.min(r.now_min, bs + b.minutes)
    const c: Cell = { category: b.category, sub: b.sub, label: b.label, source: b.source }
    for (let m = bs; m < be; m++) cells[m] = c
  }

  // 2. totals delta over the replaced range
  const totals: Totals = { ...r.totals }
  const manualBy: Record<string, number> = { ...r.manual_by_category }
  const bump = (c: Cell, delta: number) => {
    const cat = c?.category ?? 'unknown'
    const k = totalsKey(cat)
    if (k) totals[k] += delta
    else {
      totals.manual_s += delta
      manualBy[cat] = Math.max(0, (manualBy[cat] ?? 0) + delta)
      if (manualBy[cat] === 0) delete manualBy[cat]
    }
  }
  for (let m = s; m < e; m++) {
    bump(cells[m] ?? null, -60)
    cells[m] = cell
    bump(cell, 60)
  }

  // 3. run-length encode, then absorb tiny Unknown runs and merge equal neighbours (same as buildDay)
  const iso = (m: number) => new Date(startMs + m * 60000).toISOString()
  const runs: Block[] = []
  let runStart = 0
  for (let m = 1; m <= r.now_min; m++) {
    if (m === r.now_min || !sameCell(cells[m] ?? null, cells[runStart] ?? null)) {
      const c = cells[runStart] ?? null
      runs.push({
        start: iso(runStart), end: iso(m), minutes: m - runStart,
        category: c?.category ?? 'unknown', sub: c?.sub ?? null, label: c?.label ?? 'Unknown', source: c?.source ?? 'unknown',
      })
      runStart = m
    }
  }
  const blocks: Block[] = []
  for (const b of runs) {
    const prev = blocks[blocks.length - 1]
    if (prev && ((b.category === 'unknown' && b.minutes < GAP_MIN_MINUTES) || sameBlock(prev, b))) {
      prev.end = b.end
      prev.minutes += b.minutes
    } else blocks.push({ ...b })
  }
  const gaps: Gap[] = blocks.filter((b) => b.category === 'unknown').map((b) => ({ start: b.start, end: b.end, minutes: b.minutes }))
  return { ...r, blocks, gaps, totals, manual_by_category: manualBy }
}

/** Write a manual block into the result (manual blocks always win, exactly as in buildDay). */
export function insertBlock(r: DayResult, tb: TimeBlock): DayResult {
  const category = tb.category as ChartCategory
  return applyRange(r, tb.start_ts, tb.end_ts, { category, sub: tb.project_id, label: tb.label ?? titleCase(category), source: 'manual' })
}

/** Turn a range back into Unknown (a deleted manual block; the server reveals what was underneath on re-fetch). */
export function clearRange(r: DayResult, startTs: string, endTs: string): DayResult {
  return applyRange(r, startTs, endTs, null)
}

// ---- which days a queued row can change -------------------------------------------------------------------

/** Local days whose /api/day answer a written row may change; 'all' when it is a settings-like row. */
export function daysTouched(table: string, row: Record<string, unknown>, tz: string): string[] | 'all' {
  const str = (k: string) => (typeof row[k] === 'string' ? (row[k] as string) : null)
  switch (table) {
    case 'time_blocks': {
      const a = str('start_ts'), b = str('end_ts')
      const days = new Set<string>()
      if (a) days.add(localDay(a, tz))
      if (b) days.add(localDay(b, tz))
      return [...days]
    }
    case 'sleep': {
      const n = str('night_of')
      return n ? [n, addDays(n, 1)] : 'all'
    }
    case 'routine_log': case 'workouts': case 'sessions': case 'food_log': case 'checkins': {
      const d = str('local_day')
      return d ? [d] : 'all'
    }
    default:
      return 'all'
  }
}
