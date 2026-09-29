// Pure parsing for the Work routes: instants given as ISO or as a local 'HH:MM' on a day, a session span from
// {minutes} | {start, end} | {start|end, minutes}, the time-block helper body, project-name matching and the
// Mon-Sun week grouping. No D1 here, so vitest covers it in test/worker-work.test.ts.
import { HttpError, isRecord } from '../../http'
import { isCalendarDay, parseDayParam } from '../../router'
import { addDays, dayWindow, localDay, localHHMM, zonedToUTC } from '../../../shared/tz'
import type { BlockCategory } from '../../../shared/types'

/** The time_blocks.category CHECK list from schema.sql. */
export const BLOCK_CATEGORIES: readonly BlockCategory[] = [
  'sleep', 'workout', 'study', 'routine', 'meal', 'chores', 'social', 'commute', 'rest', 'phone', 'other',
]
export const MAX_SPAN_MINUTES = 24 * 60
export const MAX_BLOCKS = 200
export const MAX_NOTE_CHARS = 2000
export const MAX_LABEL_CHARS = 200
export const MAX_RANGE_DAYS = 366

const DAY_MS = 86_400_000
const HHMM = /^(\d{1,2}):(\d{2})$/
// Zoned ISO-8601 only: YYYY-MM-DDTHH:MM[:SS[.fff]] followed by Z or an offset. `new Date(s)` alone also swallows
// V8's legacy forms ('12' -> 2001-12-01, '2026-09-28' -> UTC midnight, 'Sep 28 2026 10:00' and a zone-less
// 'YYYY-MM-DDTHH:MM' read in the Worker's UTC) and rolls 2026-02-30 or 24:00 over to the next day; none of those
// is what a typo meant, so they are refused instead of landing a session on the wrong day.
const ISO_ZONED = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/
const pad = (n: number) => String(n).padStart(2, '0')

export interface When { at: Date; wall: boolean }

/** A zoned ISO-8601 instant (2026-09-28T10:00:00Z, 2026-09-28T06:00-04:00) on a real calendar day, else null. */
export function parseIso(s: string): Date | null {
  const m = ISO_ZONED.exec(s)
  if (!m || !isCalendarDay(m[1] ?? '') || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 'HH:MM' -> that wall-clock time on `day` in tz (wall: true); anything else must be a zoned ISO instant. */
export function parseWhen(v: unknown, day: string, tz: string, field: string): When {
  const bad = () => new HttpError(400, `${field} must be a zoned ISO timestamp (2026-09-28T10:00:00Z) or a local HH:MM`)
  if (typeof v !== 'string' || !v.trim()) throw bad()
  const s = v.trim()
  const m = HHMM.exec(s)
  if (m) {
    const h = Number(m[1])
    const mi = Number(m[2])
    if (h > 23 || mi > 59) throw new HttpError(400, `${field}: ${s} is not a valid time`)
    return { at: zonedToUTC(day, `${pad(h)}:${pad(mi)}`, tz), wall: true }
  }
  const d = parseIso(s)
  if (!d) throw bad()
  return { at: d, wall: false }
}

/** `day` (or ?day=) as a local day: missing -> today in tz; 'today'; or a real YYYY-MM-DD. */
export function parseDay(v: unknown, now: Date, tz: string, field = 'day'): string {
  if (v === undefined || v === null || v === '') return localDay(now, tz)
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be YYYY-MM-DD`)
  const d = parseDayParam(v, now, tz)
  if (!d) throw new HttpError(400, `${field} must be YYYY-MM-DD`)
  return d
}

function optionalMinutes(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 || n > MAX_SPAN_MINUTES) {
    throw new HttpError(400, `minutes must be a number between 1 and ${MAX_SPAN_MINUTES}`)
  }
  return n
}

const given = (v: unknown) => v !== undefined && v !== null && v !== ''

export interface Span { started_at: string; ended_at: string; duration_s: number; local_day: string }

/**
 * A finished span from {minutes} | {start, end} | {start, minutes} | {end, minutes}.
 * - minutes alone: ends now when `day` is today, else at the same wall-clock time on `day`; the start never lands
 *   before local midnight of `day` (the whole span shifts forward instead), so `local_day` stays `day`.
 * - 'HH:MM' start/end that wrap (23:30 -> 00:30) roll the end to the next day.
 * local_day is the day of started_at in tz, which is the schema's rule.
 */
export function resolveSpan(input: { start?: unknown; end?: unknown; minutes?: unknown }, day: string, tz: string, now: Date): Span {
  const minutes = optionalMinutes(input.minutes)
  const hasStart = given(input.start)
  const hasEnd = given(input.end)
  let start: Date
  let end: Date
  if (hasStart && hasEnd) {
    if (minutes !== null) throw new HttpError(400, 'give minutes or start+end, not both')
    const s = parseWhen(input.start, day, tz, 'start')
    const e = parseWhen(input.end, day, tz, 'end')
    start = s.at
    end = e.at
    if (end.getTime() <= start.getTime() && e.wall) end = new Date(end.getTime() + DAY_MS)
    if (end.getTime() <= start.getTime()) throw new HttpError(400, 'end must be after start')
  } else if (hasStart) {
    if (minutes === null) throw new HttpError(400, 'start needs an end or minutes')
    start = parseWhen(input.start, day, tz, 'start').at
    end = new Date(start.getTime() + minutes * 60_000)
  } else if (hasEnd) {
    if (minutes === null) throw new HttpError(400, 'end needs a start or minutes')
    end = parseWhen(input.end, day, tz, 'end').at
    start = new Date(end.getTime() - minutes * 60_000)
  } else {
    if (minutes === null) throw new HttpError(400, 'minutes or start+end required')
    end = day === localDay(now, tz) ? now : zonedToUTC(day, localHHMM(now, tz), tz)
    start = new Date(end.getTime() - minutes * 60_000)
    const midnight = dayWindow(day, tz).start
    if (start.getTime() < midnight.getTime()) {
      start = midnight
      end = new Date(start.getTime() + minutes * 60_000)
    }
  }
  const duration_s = Math.round((end.getTime() - start.getTime()) / 1000)
  if (duration_s > MAX_SPAN_MINUTES * 60) throw new HttpError(400, `a session cannot be longer than ${MAX_SPAN_MINUTES / 60} h`)
  return { started_at: start.toISOString(), ended_at: end.toISOString(), duration_s, local_day: localDay(start, tz) }
}

export function parseNote(v: unknown, field = 'note', max = MAX_NOTE_CHARS): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`)
  const s = v.trim()
  if (s.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`)
  return s || null
}

function parseProjectRef(v: unknown, field: string, required: boolean): string | null {
  if (v === undefined || v === null || v === '') {
    if (required) throw new HttpError(400, `${field} (a project name or id) is required`)
    return null
  }
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${field} must be a project name or id`)
  if (v.trim().length > MAX_LABEL_CHARS) throw new HttpError(400, `${field} is longer than ${MAX_LABEL_CHARS} characters`)
  return v.trim()
}

export interface SessionBody { project: string; span: Span; note: string | null; day: string }

/** POST /api/sessions body: {project, minutes | start+end (ISO or 'HH:MM'), note?, day?}. */
export function parseSessionBody(body: unknown, now: Date, tz: string): SessionBody {
  if (!isRecord(body)) throw new HttpError(400, 'body must be a JSON object')
  const project = parseProjectRef(body['project'], 'project', true) as string
  const day = parseDay(body['day'], now, tz)
  const span = resolveSpan({ start: body['start'], end: body['end'], minutes: body['minutes'] }, day, tz, now)
  return { project, span, note: parseNote(body['note']), day }
}

export interface BlockSpec { start_ts: string; end_ts: string; category: BlockCategory; label: string | null; project: string | null }

/** POST /api/time-blocks body: {blocks: [{start, end, category, label?, project?}], day?}. */
export function parseBlocksBody(body: unknown, now: Date, tz: string): { day: string; blocks: BlockSpec[] } {
  if (!isRecord(body) || !Array.isArray(body['blocks'])) throw new HttpError(400, 'blocks[] required')
  const raw = body['blocks'] as unknown[]
  if (raw.length === 0) throw new HttpError(400, 'blocks[] is empty')
  if (raw.length > MAX_BLOCKS) throw new HttpError(400, `at most ${MAX_BLOCKS} blocks per request`)
  const day = parseDay(body['day'], now, tz)
  const blocks = raw.map((b, i): BlockSpec => {
    const f = `blocks[${i}]`
    if (!isRecord(b)) throw new HttpError(400, `${f} must be an object`)
    const s = parseWhen(b['start'], day, tz, `${f}.start`)
    const e = parseWhen(b['end'], day, tz, `${f}.end`)
    let end = e.at
    if (end.getTime() <= s.at.getTime() && e.wall) end = new Date(end.getTime() + DAY_MS)
    if (end.getTime() <= s.at.getTime()) throw new HttpError(400, `${f}: end must be after start`)
    if (end.getTime() - s.at.getTime() > MAX_SPAN_MINUTES * 60_000) throw new HttpError(400, `${f}: a block cannot be longer than 24 h`)
    const category = b['category']
    if (typeof category !== 'string' || !(BLOCK_CATEGORIES as readonly string[]).includes(category)) {
      throw new HttpError(400, `${f}.category must be one of ${BLOCK_CATEGORIES.join(', ')}`)
    }
    return {
      start_ts: s.at.toISOString(),
      end_ts: end.toISOString(),
      category: category as BlockCategory,
      label: parseNote(b['label'], `${f}.label`, MAX_LABEL_CHARS),
      project: parseProjectRef(b['project'], `${f}.project`, false),
    }
  })
  return { day, blocks }
}

/** ?from / ?to for GET /api/sessions: both default to today, `to` defaults to `from`, at most a year, to >= from. */
export function parseRange(from: string | null, to: string | null, now: Date, tz: string): { from: string; to: string } {
  const f = parseDay(from, now, tz, 'from')
  const t = to === null || to === '' ? f : parseDay(to, now, tz, 'to')
  if (t < f) throw new HttpError(400, 'to must be on or after from')
  if (daysBetween(f, t) > MAX_RANGE_DAYS) throw new HttpError(400, `range longer than ${MAX_RANGE_DAYS} days`)
  return { from: f, to: t }
}

export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number) as [number, number, number]
  const [by, bm, bd] = b.split('-').map(Number) as [number, number, number]
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / DAY_MS)
}

export interface ProjectRef { id: string; name: string; archived_at: string | null; position: number }

/** A project by id, else by case-insensitive name (active before archived, then by position); null when unknown. */
export function matchProject<T extends ProjectRef>(list: readonly T[], ref: string): T | null {
  const byId = list.find((p) => p.id === ref)
  if (byId) return byId
  const name = ref.trim().toLowerCase()
  const hits = list
    .filter((p) => p.name.trim().toLowerCase() === name)
    .sort((a, b) => (a.archived_at ? 1 : 0) - (b.archived_at ? 1 : 0) || a.position - b.position)
  return hits[0] ?? null
}

export interface WeekRow { local_day: string; project_id: string; seconds: number | null }
export interface WeekDay { local_day: string; seconds: number; by_project: Record<string, number> }

/** Seven days from `start` (a Monday) with total and per-project seconds; rows outside the week are ignored. */
export function groupWeek(rows: readonly WeekRow[], start: string): WeekDay[] {
  const days: WeekDay[] = Array.from({ length: 7 }, (_, i) => ({ local_day: addDays(start, i), seconds: 0, by_project: {} }))
  const index = new Map(days.map((d, i) => [d.local_day, i]))
  for (const r of rows) {
    const i = index.get(r.local_day)
    const d = i === undefined ? undefined : days[i]
    if (!d) continue
    const s = Number(r.seconds) || 0
    d.seconds += s
    d.by_project[r.project_id] = (d.by_project[r.project_id] ?? 0) + s
  }
  return days
}
