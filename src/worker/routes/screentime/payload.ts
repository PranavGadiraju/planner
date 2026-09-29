// POST /api/screentime: body validation + normalisation and the SQL plan for one window replace. Pure (no D1 or
// Worker globals) so vitest can exercise every 400 path and the statement plan without a database.
//
// Contract (docs/plan.md, "THE /api/screentime CONTRACT"):
//   {source: 'mac'|'phone', device, window: {from, to} (to - from <= 48 h),
//    hours: [{hour_start (ISO at minute 0), app_id ('_total' for phone), seconds 0..3600}],
//    intervals?: [{start, end, top_app}], apps?: [{app_id, label}]}
// Inside ONE batch: delete the (source, device) rows whose hour_start / start_ts fall in [from, to), upsert the new
// rows, bump app_categories.seen_seconds for every app id seen, mark automation_health(source) and dirty_days.
import { HttpError, isRecord } from '../../http'
import { addDays, localDay } from '../../../shared/tz'
import type { Role } from '../../../shared/types'
import type { Scalar } from '../../db'

export type ScreenSource = 'mac' | 'phone'

export interface HourRow { hour_start: string; app_id: string; seconds: number }
export interface IntervalRow { start: string; end: string; top_app: string | null }
export interface AppRow { app_id: string; label: string | null }

export interface ScreentimePayload {
  source: ScreenSource
  device: string
  window: { from: string; to: string }
  hours: HourRow[]
  intervals: IntervalRow[]
  apps: AppRow[]
}

export interface Statement { sql: string; params: Scalar[] }

export const MAX_SCREENTIME_BODY = 1024 * 1024
export const MAX_WINDOW_MS = 48 * 3600_000
// Row caps sized to what a 48 h window can really hold (a real hourly push is a few hundred rows; a 48 h backfill
// with ~60 distinct apps per hour is 3000), so a misused token or a client bug cannot make the validate/dedupe/sort
// loops below eat the 10 ms CPU budget.
export const MAX_HOURS = 3_000
export const MAX_INTERVALS = 2_000
export const MAX_APPS = 2_000
const MAX_ID = 200
const MAX_DEVICE = 100
/** D1 allows at most 100 bound parameters per statement. */
export const MAX_BINDINGS = 100

/** Hour totals that are not real apps ('_total' for phone days) never enter app_categories. */
export function isPseudoApp(appId: string): boolean {
  return appId.startsWith('_')
}

/** An ISO-8601 timestamp normalised to what the Worker writes ('2026-09-28T13:00:00.000Z'), or null. */
export function normIso(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) return null
  const t = new Date(v).getTime()
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export function floorHourIso(iso: string): string {
  return new Date(Math.floor(new Date(iso).getTime() / 3600_000) * 3600_000).toISOString()
}

function bad(msg: string): never {
  throw new HttpError(400, msg)
}

function idString(v: unknown, what: string): string {
  if (typeof v !== 'string') bad(`${what} must be a string`)
  const s = v.trim()
  if (!s) bad(`${what} must not be empty`)
  if (s.length > MAX_ID) bad(`${what} longer than ${MAX_ID} characters`)
  return s
}

/**
 * Validate a request body against the contract and return a normalised payload (timestamps canonical, duplicate
 * hour rows merged, duplicate intervals collapsed, app ids trimmed). Throws HttpError(400) on any violation and
 * HttpError(403) when the mac role sends anything but source 'mac'.
 */
export function parseScreentimeBody(body: unknown, role: Role): ScreentimePayload {
  if (!isRecord(body)) bad('body must be a JSON object')
  const source = body['source']
  if (source !== 'mac' && source !== 'phone') bad("source must be 'mac' or 'phone'")
  if (role === 'mac' && source !== 'mac') throw new HttpError(403, "the mac token may only send source 'mac'")
  if (role === 'shortcut') throw new HttpError(403, 'forbidden')

  const device = idString(body['device'], 'device')
  if (device.length > MAX_DEVICE) bad(`device longer than ${MAX_DEVICE} characters`)

  const win = body['window']
  if (!isRecord(win)) bad('window {from, to} required')
  const from = normIso(win['from']) ?? bad('window.from must be an ISO timestamp')
  const to = normIso(win['to']) ?? bad('window.to must be an ISO timestamp')
  const fromMs = new Date(from).getTime()
  const toMs = new Date(to).getTime()
  if (toMs <= fromMs) bad('window.to must be after window.from')
  if (toMs - fromMs > MAX_WINDOW_MS) bad('window must be at most 48 hours')
  const hourFloor = floorHourIso(from)

  const hoursIn = body['hours']
  if (!Array.isArray(hoursIn)) bad('hours[] required')
  if (hoursIn.length === 0) bad('hours must not be empty (an empty window is never posted)')
  if (hoursIn.length > MAX_HOURS) bad(`at most ${MAX_HOURS} hour rows per request`)
  const hourMap = new Map<string, HourRow>()
  hoursIn.forEach((h, i) => {
    if (!isRecord(h)) bad(`hours[${i}] must be an object`)
    const hourStart = normIso(h['hour_start']) ?? bad(`hours[${i}].hour_start must be an ISO timestamp`)
    if (hourStart !== floorHourIso(hourStart)) bad(`hours[${i}].hour_start must be at minute 0 of an hour`)
    if (hourStart < hourFloor || hourStart >= to) bad(`hours[${i}].hour_start is outside the window`)
    const appId = idString(h['app_id'], `hours[${i}].app_id`)
    const seconds = h['seconds']
    if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 0 || seconds > 3600) {
      bad(`hours[${i}].seconds must be an integer between 0 and 3600`)
    }
    const key = `${hourStart}|${appId}`
    const cur = hourMap.get(key)
    if (cur) cur.seconds = Math.min(3600, cur.seconds + seconds)
    else hourMap.set(key, { hour_start: hourStart, app_id: appId, seconds })
  })
  const hours = [...hourMap.values()].sort((a, b) => (a.hour_start === b.hour_start ? (a.app_id < b.app_id ? -1 : 1) : a.hour_start < b.hour_start ? -1 : 1))

  const intervalsIn = body['intervals'] ?? []
  if (!Array.isArray(intervalsIn)) bad('intervals must be an array')
  if (intervalsIn.length > MAX_INTERVALS) bad(`at most ${MAX_INTERVALS} intervals per request`)
  const ivMap = new Map<string, IntervalRow>()
  intervalsIn.forEach((iv, i) => {
    if (!isRecord(iv)) bad(`intervals[${i}] must be an object`)
    const start = normIso(iv['start']) ?? bad(`intervals[${i}].start must be an ISO timestamp`)
    const end = normIso(iv['end']) ?? bad(`intervals[${i}].end must be an ISO timestamp`)
    if (end <= start) bad(`intervals[${i}].end must be after start`)
    if (start < from || start >= to) bad(`intervals[${i}].start is outside the window`)
    const top = iv['top_app']
    const topApp = top === null || top === undefined ? null : idString(top, `intervals[${i}].top_app`)
    ivMap.set(start, { start, end, top_app: topApp })
  })
  const intervals = [...ivMap.values()].sort((a, b) => (a.start < b.start ? -1 : 1))

  const appsIn = body['apps'] ?? []
  if (!Array.isArray(appsIn)) bad('apps must be an array')
  if (appsIn.length > MAX_APPS) bad(`at most ${MAX_APPS} apps per request`)
  const appMap = new Map<string, AppRow>()
  appsIn.forEach((a, i) => {
    if (!isRecord(a)) bad(`apps[${i}] must be an object`)
    const appId = idString(a['app_id'], `apps[${i}].app_id`)
    const raw = a['label']
    if (raw !== null && raw !== undefined && typeof raw !== 'string') bad(`apps[${i}].label must be a string or null`)
    const label = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, MAX_ID) : null
    const cur = appMap.get(appId)
    appMap.set(appId, { app_id: appId, label: cur?.label ?? label })
  })
  const apps = [...appMap.values()].sort((a, b) => (a.app_id < b.app_id ? -1 : 1))

  return { source, device, window: { from, to }, hours, intervals, apps }
}

/** Every local day (in tz) the half-open window [from, to) touches, in order. */
export function daysTouched(from: string, to: string, tz: string): string[] {
  const first = localDay(from, tz)
  const last = localDay(new Date(new Date(to).getTime() - 1), tz)
  const days: string[] = []
  for (let d = first; d <= last; d = addDays(d, 1)) {
    days.push(d)
    if (days.length > 4) break // 48 h can span at most 3 local days; guard against a runaway loop
  }
  return days
}

/** Per-app seconds over the payload plus every app id an interval names, minus pseudo apps such as '_total'. */
export function appsSeen(p: ScreentimePayload): { app_id: string; label: string | null; seconds: number }[] {
  const labels = new Map(p.apps.map((a) => [a.app_id, a.label]))
  const secs = new Map<string, number>()
  for (const h of p.hours) secs.set(h.app_id, (secs.get(h.app_id) ?? 0) + h.seconds)
  for (const iv of p.intervals) if (iv.top_app && !secs.has(iv.top_app)) secs.set(iv.top_app, 0)
  for (const a of p.apps) if (!secs.has(a.app_id)) secs.set(a.app_id, 0)
  return [...secs.entries()]
    .filter(([id]) => !isPseudoApp(id))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([app_id, seconds]) => ({ app_id, label: labels.get(app_id) ?? null, seconds }))
}

function chunk<T>(rows: readonly T[], perRow: number): T[][] {
  const size = Math.max(1, Math.floor(MAX_BINDINGS / perRow))
  const out: T[][] = []
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size))
  return out
}

const HOUR_COLS = 6
const HOUR_SQL_HEAD = 'INSERT INTO screen_hours (source, device, hour_start, app_id, seconds, updated_at) VALUES '
const HOUR_SQL_TAIL = ' ON CONFLICT(source, device, hour_start, app_id) DO UPDATE SET seconds = excluded.seconds, updated_at = excluded.updated_at'
const IV_COLS = 6
const IV_SQL_HEAD = 'INSERT INTO screen_intervals (source, device, start_ts, end_ts, top_app, updated_at) VALUES '
const IV_SQL_TAIL = ' ON CONFLICT(source, device, start_ts) DO UPDATE SET end_ts = excluded.end_ts, top_app = excluded.top_app, updated_at = excluded.updated_at'
const APP_COLS = 4
const APP_SQL_HEAD = 'INSERT INTO app_categories (app_id, label, seen_seconds, updated_at) VALUES '
// seen_seconds accumulates (re-sent overlap included: it only ranks the triage list). label fills in only when the
// row has none. updated_at is left alone on conflict: it is the app's last-writer-wins guard for category edits, and
// bumping it here would let an hourly push silently beat a category the user picked while offline.
const APP_SQL_TAIL =
  ' ON CONFLICT(app_id) DO UPDATE SET seen_seconds = app_categories.seen_seconds + excluded.seen_seconds, label = COALESCE(app_categories.label, excluded.label)'
export const HEALTH_SQL =
  'INSERT INTO automation_health (source, last_ok_at, detail) VALUES (?, ?, ?) ON CONFLICT(source) DO UPDATE SET last_ok_at = excluded.last_ok_at, detail = excluded.detail'
export const DIRTY_SQL = 'INSERT INTO dirty_days (local_day, marked_at) VALUES (?, ?) ON CONFLICT(local_day) DO UPDATE SET marked_at = excluded.marked_at'

const values = (rows: number, cols: number) => Array.from({ length: rows }, () => `(${Array(cols).fill('?').join(', ')})`).join(', ')

export interface ScreentimePlan {
  /** SELECT app_id FROM app_categories WHERE app_id IN (...) chunks; run first so the response can count new apps. */
  lookups: Statement[]
  /** Deletes, upserts, health and dirty-day marks, in order, for one transactional batch. */
  writes: Statement[]
  days: string[]
  dirtyDays: string[]
  apps: ReturnType<typeof appsSeen>
}

/** The statements one accepted payload turns into. `now` is the server time, `tz` the Worker's TZ. */
export function planScreentime(p: ScreentimePayload, now: Date, tz: string): ScreentimePlan {
  const nowIso = now.toISOString()
  const today = localDay(now, tz)
  const { from, to } = p.window
  const apps = appsSeen(p)
  const days = daysTouched(from, to, tz)
  const dirtyDays = days.filter((d) => d < today)

  const lookups: Statement[] = chunk(apps, 1).map((c) => ({
    sql: `SELECT app_id FROM app_categories WHERE app_id IN (${c.map(() => '?').join(', ')})`,
    params: c.map((a) => a.app_id),
  }))

  const writes: Statement[] = [
    { sql: 'DELETE FROM screen_hours WHERE source = ? AND device = ? AND hour_start >= ? AND hour_start < ?', params: [p.source, p.device, from, to] },
    { sql: 'DELETE FROM screen_intervals WHERE source = ? AND device = ? AND start_ts >= ? AND start_ts < ?', params: [p.source, p.device, from, to] },
  ]
  for (const c of chunk(p.hours, HOUR_COLS)) {
    writes.push({
      sql: HOUR_SQL_HEAD + values(c.length, HOUR_COLS) + HOUR_SQL_TAIL,
      params: c.flatMap((h) => [p.source, p.device, h.hour_start, h.app_id, h.seconds, nowIso]),
    })
  }
  for (const c of chunk(p.intervals, IV_COLS)) {
    writes.push({
      sql: IV_SQL_HEAD + values(c.length, IV_COLS) + IV_SQL_TAIL,
      params: c.flatMap((iv) => [p.source, p.device, iv.start, iv.end, iv.top_app, nowIso]),
    })
  }
  for (const c of chunk(apps, APP_COLS)) {
    writes.push({
      sql: APP_SQL_HEAD + values(c.length, APP_COLS) + APP_SQL_TAIL,
      params: c.flatMap((a) => [a.app_id, a.label, a.seconds, nowIso]),
    })
  }
  writes.push({ sql: HEALTH_SQL, params: [p.source, nowIso, `${p.hours.length} hours / ${p.intervals.length} intervals`] })
  for (const d of dirtyDays) writes.push({ sql: DIRTY_SQL, params: [d, nowIso] })

  return { lookups, writes, days, dirtyDays, apps }
}
