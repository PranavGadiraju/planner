import type { Sleep, Source } from './types'
import { addDays, localDay, localParts, zonedToUTC } from './tz'

export const BED_DUP_MS = 10 * 60_000
export const WAKE_MIN_MS = 3 * 3600_000
export const OPEN_SLEEP_MAX_MS = 14 * 3600_000

/** The night a bed tap belongs to: 23:30 and 01:00 both map to the earlier calendar date. */
export function nightOf(now: Date, tz: string): string {
  return localDay(new Date(now.getTime() - 12 * 3600_000), tz)
}

/** Instant of the bed target for a night: times >= 12:00 fall on night_of, earlier times on the next calendar day. */
export function bedTargetInstant(night_of: string, target_bed: string, tz: string): Date {
  const hour = Number(target_bed.split(':')[0])
  return zonedToUTC(hour >= 12 ? night_of : addDays(night_of, 1), target_bed, tz)
}

export function lateMinutes(bed: Date, night_of: string, target_bed: string, tz: string): number {
  return Math.round((bed.getTime() - bedTargetInstant(night_of, target_bed, tz).getTime()) / 60000)
}

export type BedTapAction = 'bed' | 'bed_duplicate' | 'bed_ignored' | 'bed_daytime_ignored' | 'wake' | 'wake_duplicate' | 'nap_then_bed'
export interface BedTapResult {
  action: BedTapAction
  row: Sleep | null
  changed: boolean
  nap?: { start: string; end: string }
}

/**
 * Nightstand sticker state machine. `existing` is the sleep row for nightOf(now), if any.
 *  - no row, evening/night: insert bed_ts = now
 *  - no row, daytime (10:00-17:59 local): ignored (naps are logged in the app)
 *  - open row: < 10 min duplicate; 10 min-3 h ignored (first bedtime stands); >= 3 h => wake
 *  - closed row and local hour >= 18: earlier interval becomes a nap, row restarts at now
 *  - closed row, daytime: wake_duplicate
 */
export function applyBedTap(
  existing: Sleep | null,
  now: Date,
  tz: string,
  settings: { bed_target: string },
  source: Source,
): BedTapResult {
  const nowIso = now.toISOString()
  const night = nightOf(now, tz)
  const hour = localParts(now, tz).h
  const live = existing && !existing.deleted_at ? existing : null
  if (!live) {
    if (hour >= 10 && hour < 18) return { action: 'bed_daytime_ignored', row: null, changed: false }
    const row: Sleep = {
      night_of: night, bed_ts: nowIso, wake_ts: null, bed_source: source, wake_source: null,
      target_bed: settings.bed_target, late_min: lateMinutes(now, night, settings.bed_target, tz),
      updated_at: nowIso, deleted_at: null,
    }
    return { action: 'bed', row, changed: true }
  }
  if (!live.wake_ts) {
    const delta = now.getTime() - new Date(live.bed_ts).getTime()
    if (delta < BED_DUP_MS) return { action: 'bed_duplicate', row: live, changed: false }
    if (delta < WAKE_MIN_MS) return { action: 'bed_ignored', row: live, changed: false }
    return { action: 'wake', changed: true, row: { ...live, wake_ts: nowIso, wake_source: source, updated_at: nowIso } }
  }
  if (hour >= 18) {
    const row: Sleep = {
      ...live, bed_ts: nowIso, wake_ts: null, bed_source: source, wake_source: null,
      target_bed: settings.bed_target, late_min: lateMinutes(now, night, settings.bed_target, tz), updated_at: nowIso,
    }
    return { action: 'nap_then_bed', changed: true, row, nap: { start: live.bed_ts, end: live.wake_ts } }
  }
  return { action: 'wake_duplicate', row: live, changed: false }
}

/** Close an open sleep row from an explicit wake signal (routine tap, alarm, app). Returns null when nothing to do. */
export function applyWake(open: Sleep | null, now: Date, source: Sleep['wake_source']): Sleep | null {
  if (!open || open.deleted_at || open.wake_ts) return null
  if (now.getTime() - new Date(open.bed_ts).getTime() < WAKE_MIN_MS) return null
  const nowIso = now.toISOString()
  return { ...open, wake_ts: nowIso, wake_source: source, updated_at: nowIso }
}

/**
 * Consecutive nights (ending with the most recent row) that were on time (late_min <= grace) and confirmed (wake set),
 * except that an open row for tonight counts if it was on time.
 */
export function bedtimeStreak(rows: Sleep[], grace: number): number {
  const live = rows.filter((r) => !r.deleted_at).sort((a, b) => (a.night_of < b.night_of ? 1 : -1))
  let streak = 0
  let expect: string | null = null
  for (const r of live) {
    if (expect && r.night_of !== expect) break
    const confirmed = r.wake_ts !== null || streak === 0
    if (r.late_min > grace || !confirmed) break
    streak++
    expect = addDays(r.night_of, -1)
  }
  return streak
}

export function sleepDurationMin(row: Sleep): number | null {
  if (!row.wake_ts) return null
  return Math.round((new Date(row.wake_ts).getTime() - new Date(row.bed_ts).getTime()) / 60000)
}
