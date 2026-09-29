// /api/summary range planning: validate from/to and decide, per day, whether it is live (today), final, to be
// rebuilt now (at most RECOMPUTE_CAP per request, oldest first) or returned as it is. Pure; vitest imports it.
import { HttpError } from '../../http'
import { parseDayParam } from '../../router'
import { addDays } from '../../../shared/tz'
import type { DaySummary } from './summary'

export const MAX_RANGE_DAYS = 62
export const RECOMPUTE_CAP = 3

/** Every local day from `from` to `to` inclusive. */
export function dayRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d)
  return out
}

/** from/to query params -> a validated inclusive range of at most MAX_RANGE_DAYS days (400 otherwise). */
export function parseRange(from: string | null, to: string | null, now: Date, tz: string): { from: string; to: string } {
  const f = parseDayParam(from ?? '', now, tz)
  const t = parseDayParam(to ?? '', now, tz)
  if (!f || !t) throw new HttpError(400, 'from and to must be YYYY-MM-DD (or today)')
  if (f > t) throw new HttpError(400, 'from must not be after to')
  if (dayRange(f, t).length > MAX_RANGE_DAYS) throw new HttpError(400, `at most ${MAX_RANGE_DAYS} days per request`)
  return { from: f, to: t }
}

export interface RangePlan {
  /** Days returned straight from day_summary (final rows nothing marked dirty). */
  final: string[]
  /** Today, computed live and never stored (null when the range ends before today). */
  live: string | null
  /** Missing, dirty or non-final past days rebuilt in this request, oldest first (at most `cap`). */
  recompute: string[]
  /** Past days beyond the cap that have no row or a dirty one: returned as they are with stale: true. */
  stale: string[]
  /** Non-final rows beyond the cap that nothing marked dirty: served as they are, without the flag. */
  asIs: string[]
}

/**
 * Pure: decide what to do with each day of a range. Future days are dropped; today is live; final rows pass
 * through; everything else queues for a rebuild oldest first. Beyond the cap, a day is `stale` only when its
 * row is missing or marked in dirty_days (a non-final row nothing touched is still the best known value).
 */
export function planRange(days: readonly string[], rows: ReadonlyMap<string, DaySummary>, dirty: ReadonlySet<string>, today: string, cap = RECOMPUTE_CAP): RangePlan {
  const plan: RangePlan = { final: [], live: null, recompute: [], stale: [], asIs: [] }
  const pending: string[] = []
  for (const d of days) {
    if (d > today) continue
    if (d === today) { plan.live = d; continue }
    const row = rows.get(d)
    if (row && row.final === 1 && !dirty.has(d)) plan.final.push(d)
    else pending.push(d)
  }
  pending.sort()
  plan.recompute = pending.slice(0, cap)
  for (const d of pending.slice(cap)) {
    // Beyond the cap only a missing or dirty day is flagged; a fresh non-final row is served as is (writes that
    // touch a past day, including back-dated taps, mark it dirty, so "not dirty" really means up to date).
    if (!rows.has(d) || dirty.has(d)) plan.stale.push(d)
    else plan.asIs.push(d)
  }
  return plan
}
