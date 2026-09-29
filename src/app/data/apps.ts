// Mac app categories: the triage list (GET /api/apps), one-tap category writes through the outbox, and the pure
// helpers behind the Mac apps screen and the health strip (unit-tested in test/app-apps.test.ts).
import { shortBundle } from '@shared/day'
import { localDay, localParts } from '@shared/tz'
import type { AppCategory, AppCategoryRow, TodayPayload } from '@shared/types'
import { apiGet, type GetResult } from './api'
import * as outbox from './outbox'
import { agoLabel, hhmm } from './format'
import { today } from './store'

export const CATEGORIES: readonly AppCategory[] = ['dev', 'work', 'comms', 'browsing', 'media', 'social', 'other']

export const CATEGORY_NAMES: Record<AppCategory, string> = {
  dev: 'Dev', work: 'Work', comms: 'Comms', browsing: 'Browsing', media: 'Media', social: 'Social', other: 'Other',
}

export interface AppsPayload { apps: AppCategoryRow[] }

export function loadApps(): Promise<GetResult<AppsPayload>> {
  return apiGet<AppsPayload>('/api/apps', 'apps')
}

/** Label when the Mac resolved one, else the last segment of the bundle id ("com.apple.Safari" -> "Safari"). */
export function displayName(row: Pick<AppCategoryRow, 'app_id' | 'label'>): string {
  const label = row.label?.trim()
  return label || shortBundle(row.app_id) || row.app_id
}

/** "12 h" / "1 h 20" / "35 min" / "< 1 min" for the seen_seconds counter; "not seen" for a seeded row the Mac never reported. */
export function seenLabel(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s === 0) return 'not seen'
  if (s < 60) return '< 1 min'
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const r = min % 60
  if (h >= 10 || r === 0) return `${h} h`
  return `${h} h ${String(r).padStart(2, '0')}`
}

/** Case-insensitive match on the label, the bundle id and the category name. */
export function filterApps<T extends Pick<AppCategoryRow, 'app_id' | 'label' | 'category'>>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...rows]
  return rows.filter((r) => r.app_id.toLowerCase().includes(q) || (r.label ?? '').toLowerCase().includes(q) || (r.category ?? '').includes(q))
}

export interface AppGroup { category: AppCategory; rows: AppCategoryRow[]; seconds: number }

/** Live rows split into the triage list (NULL category, most seen first) and one group per category in CATEGORIES order. */
export function splitApps(rows: readonly AppCategoryRow[]): { triage: AppCategoryRow[]; groups: AppGroup[] } {
  const live = rows.filter((r) => !r.deleted_at)
  const bySeen = (a: AppCategoryRow, b: AppCategoryRow) => b.seen_seconds - a.seen_seconds || (a.app_id < b.app_id ? -1 : 1)
  const triage = live.filter((r) => r.category === null).sort(bySeen)
  const groups: AppGroup[] = []
  for (const category of CATEGORIES) {
    const rowsIn = live.filter((r) => r.category === category).sort(bySeen)
    if (rowsIn.length) groups.push({ category, rows: rowsIn, seconds: rowsIn.reduce((n, r) => n + r.seen_seconds, 0) })
  }
  return { triage, groups }
}

/** The row the app writes: category + label only, so a stale seen_seconds never overwrites the server's counter. */
export function categoryRow(row: AppCategoryRow, category: AppCategory, at: Date = new Date()): Record<string, unknown> {
  return { app_id: row.app_id, label: row.label, category, updated_at: at.toISOString(), deleted_at: null }
}

/** Queue the category write and keep the Today payload's triage count in step (optimistic). */
export async function setCategory(row: AppCategoryRow, category: AppCategory): Promise<void> {
  await outbox.enqueue('app_categories', categoryRow(row, category))
  const p = today.value
  if (p && row.category === null) {
    today.value = { ...p, health: { ...p.health, apps_to_triage: Math.max(0, p.health.apps_to_triage - 1) } }
  }
}

// ---- health strip ------------------------------------------------------------------------------------

export interface HealthLine { text: string; warn: boolean }

export const MAC_STALE_MS = 3 * 3600_000
/** A quiet Mac only counts as stale during the day: 08:00 <= local hour < 23. */
export const MAC_WATCH_HOURS: readonly [number, number] = [8, 23]

/** The newer of the last pushed hour and the last successful push, or null when the Mac never posted. */
export function macLastSeen(health: Pick<TodayPayload['health'], 'rows' | 'mac_last_hour'>): string | null {
  const row = health.rows.find((r) => r.source === 'mac')?.last_ok_at ?? null
  const hour = health.mac_last_hour
  if (row && hour) return row > hour ? row : hour
  return row ?? hour
}

/** "Mac: last push 4 h ago" (warn when older than 3 h during the day) or "Mac: no data yet". */
export function macStatus(health: Pick<TodayPayload['health'], 'rows' | 'mac_last_hour'>, now: Date, tz: string): HealthLine {
  const at = macLastSeen(health)
  if (!at) return { text: 'Mac: no data yet', warn: false }
  const age = now.getTime() - new Date(at).getTime()
  const h = localParts(now, tz).h
  const watching = h >= MAC_WATCH_HOURS[0] && h < MAC_WATCH_HOURS[1]
  return { text: `Mac: last push ${agoLabel(at, now)}`, warn: watching && age > MAC_STALE_MS }
}

/** Phone hours come from a pasted Screen Time screenshot, so "none today" is a nudge rather than a fault. */
export function phoneStatus(health: Pick<TodayPayload['health'], 'phone_last_hour'>, now: Date, tz: string): HealthLine {
  const last = health.phone_last_hour
  if (last && localDay(last, tz) === localDay(now, tz)) return { text: `Phone: today through ${hhmm(last, tz)}`, warn: false }
  return { text: 'Phone: none today · paste a Screen Time screenshot into Claude Code', warn: false }
}
