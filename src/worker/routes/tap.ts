// POST /api/tap — the single ingest for every NFC sticker (and the app's own tap buttons).
// All day/state logic comes from src/shared/{tz,routine,sleep}.ts; this file only reads rows, applies, writes, and phrases.
import type { RouteContext } from '../env'
import { HttpError, isRecord, json, readJson } from '../http'
import { parseSettings, SETTINGS_SQL, upsertFor } from '../db'
import type { SettingsRow } from '../db'
import { addDays, localDay, localHHMM } from '../../shared/tz'
import { applyRoutineTap, routineDurationMin } from '../../shared/routine'
import { applyBedTap, applyWake, bedtimeStreak, nightOf, sleepDurationMin } from '../../shared/sleep'
import type { BedTapResult } from '../../shared/sleep'
import type { RoutineItem, RoutineLog, Sleep, Source, TapAction, TapResponse } from '../../shared/types'

const SLEEP_HISTORY_SQL = 'SELECT * FROM sleep WHERE deleted_at IS NULL ORDER BY night_of DESC LIMIT 60'
const TAP_LOG_SQL = 'INSERT INTO tap_log (ts, item, role, result) VALUES (?, ?, ?, ?)'
const NFC_OK_SQL = "INSERT INTO automation_health (source, last_ok_at) VALUES ('nfc', ?) ON CONFLICT(source) DO UPDATE SET last_ok_at = excluded.last_ok_at"
const NFC_REACHED_WITH_ERROR_SQL =
  "INSERT INTO automation_health (source, last_ok_at, last_error_at, last_error) VALUES ('nfc', ?, ?, ?) " +
  'ON CONFLICT(source) DO UPDATE SET last_ok_at = excluded.last_ok_at, last_error_at = excluded.last_error_at, last_error = excluded.last_error'
const NFC_ERROR_SQL =
  "INSERT INTO automation_health (source, last_error_at, last_error) VALUES ('nfc', ?, ?) " +
  'ON CONFLICT(source) DO UPDATE SET last_error_at = excluded.last_error_at, last_error = excluded.last_error'

interface TapBody { item: string; at: Date }

/** {item, ts?} -> the item slug and the instant the state machines run at. Throws HttpError(400/413) on a malformed body. */
async function parseTapBody(c: RouteContext, role: 'shortcut' | 'app'): Promise<TapBody> {
  const body = await readJson<unknown>(c.request)
  if (!isRecord(body)) throw new HttpError(400, 'body must be a JSON object')
  const item = typeof body['item'] === 'string' ? body['item'].trim() : ''
  if (!item) throw new HttpError(400, 'item required')
  // The shortcut role is always server-timestamped; the app may back-date its own taps.
  let at = c.now
  if (role === 'app' && body['ts'] !== undefined) {
    const t = typeof body['ts'] === 'string' ? new Date(body['ts']) : new Date(NaN)
    if (Number.isNaN(t.getTime())) throw new HttpError(400, 'ts must be an ISO timestamp')
    at = t
  }
  return { item, at }
}

export async function tap(c: RouteContext): Promise<Response> {
  const { env, role } = c
  if (role !== 'shortcut' && role !== 'app') throw new HttpError(403, 'forbidden')
  const db = env.DB
  // Arrival time stamps tap_log and automation_health (proof the automation fired now); a back-dated `ts` only
  // moves the routine/sleep state machines.
  const arrivedIso = c.now.toISOString()

  let parsed: TapBody
  try {
    parsed = await parseTapBody(c, role)
  } catch (e) {
    // A malformed body still leaves a trace: the sticker "did something", and a broken Shortcut shows up in health.
    if (e instanceof HttpError) {
      const writes = [db.prepare(TAP_LOG_SQL).bind(arrivedIso, '(bad body)', role, 'bad_request')]
      if (role === 'shortcut') writes.push(db.prepare(NFC_ERROR_SQL).bind(arrivedIso, e.message))
      await db.batch(writes)
    }
    throw e
  }
  const { item, at: now } = parsed
  const key = item.toLowerCase()
  const tz = env.TZ
  const today = localDay(now, tz)
  const night = nightOf(now, tz)
  const source: Source = role === 'shortcut' ? 'nfc' : 'app'

  const [settingsR, sleepR, itemR, logR, countR] = await db.batch([
    db.prepare(SETTINGS_SQL),
    db.prepare(SLEEP_HISTORY_SQL),
    db.prepare('SELECT * FROM routine_items WHERE lower(id) = ? AND active = 1 AND deleted_at IS NULL LIMIT 1').bind(key),
    db.prepare('SELECT * FROM routine_log WHERE local_day = ? AND lower(item_id) = ? LIMIT 1').bind(today, key),
    db.prepare('SELECT COUNT(*) AS n FROM routine_log WHERE local_day = ? AND deleted_at IS NULL').bind(today),
  ])
  const settings = parseSettings((settingsR?.results ?? []) as SettingsRow[])
  const sleepRows = (sleepR?.results ?? []) as Sleep[]
  const routineItem = ((itemR?.results ?? []) as RoutineItem[])[0] ?? null
  const existingLog = ((logR?.results ?? []) as RoutineLog[])[0] ?? null
  const liveRoutineToday = Number(((countR?.results ?? []) as { n: number }[])[0]?.n ?? 0)

  const hhmm = (ts: string | null | undefined) => (ts ? localHHMM(ts, tz) : '?')
  const findNight = (n: string): Sleep | null => sleepRows.find((r) => r.night_of === n) ?? null
  const openAmong = (nights: string[]): Sleep | null =>
    sleepRows.find((r) => nights.includes(r.night_of) && !r.wake_ts) ?? null
  const streakWith = (row: Sleep | null): number =>
    bedtimeStreak(row ? [row, ...sleepRows.filter((r) => r.night_of !== row.night_of)] : sleepRows, settings.late_grace_min)

  const writes: D1PreparedStatement[] = []
  const upsert = (table: string, row: object) => {
    const u = upsertFor(table, row, false) // server-authoritative: no updated_at guard
    writes.push(db.prepare(u.sql).bind(...u.params))
  }

  let action: TapAction
  let message: string
  let status = 200
  let itemOut = item

  if (key === 'bed') {
    const r = applyBedTap(findNight(night), now, tz, settings, source)
    action = r.action
    if (r.changed && r.row) {
      upsert('sleep', r.row)
      if (r.action === 'nap_then_bed' && r.nap) {
        upsert('time_blocks', {
          id: crypto.randomUUID(), start_ts: r.nap.start, end_ts: r.nap.end, category: 'sleep', label: 'nap',
          project_id: null, source: 'app', created_at: arrivedIso, updated_at: arrivedIso, deleted_at: null,
        })
      }
    }
    message = bedMessage(r, hhmm, r.changed ? streakWith(r.row) : streakWith(null))
  } else if (key === 'wake') {
    const open = openAmong([night, addDays(night, -1)])
    const woke = applyWake(open, now, source)
    if (woke) {
      action = 'wake'
      upsert('sleep', woke)
      message = `Up ${hhmm(woke.wake_ts)} · ${durationText(sleepDurationMin(woke))}`
    } else {
      action = 'wake_duplicate'
      message = open ? `In bed since ${hhmm(open.bed_ts)} · too soon to wake` : 'Already up'
    }
  } else if (key === 'winddown') {
    action = 'winddown'
    const last = findNight(addDays(night, -1))
    message = `Wind down · streak ${streakWith(null)}` + (last ? ` · last night ${lateText(last.late_min)}` : '')
  } else if (routineItem) {
    itemOut = routineItem.id
    const r = applyRoutineTap(existingLog, now, { local_day: today, item_id: routineItem.id, source })
    action = r.action
    let wakeNote = ''
    if (r.changed) {
      upsert('routine_log', r.row)
      // The first routine start of the day is the wake signal (you had to get out of bed to tap it).
      if (r.action === 'routine_started' && liveRoutineToday === 0) {
        const woke = applyWake(openAmong([addDays(today, -1), today]), now, 'routine')
        if (woke) {
          upsert('sleep', woke)
          wakeNote = ` · slept ${durationText(sleepDurationMin(woke))}`
        }
      }
    }
    message = routineMessage(routineItem, r.action, r.row, hhmm) + wakeNote
  } else {
    action = 'unknown_item'
    status = 400
    message = `Unknown item "${item}"`
  }

  // Every call is logged at its arrival time, including duplicates and rejects; the shortcut role also proves the
  // automation is alive (an unknown item still reached the server, so last_ok_at moves too).
  writes.push(db.prepare(TAP_LOG_SQL).bind(arrivedIso, itemOut, role, action))
  if (role === 'shortcut') {
    writes.push(status === 200 ? db.prepare(NFC_OK_SQL).bind(arrivedIso) : db.prepare(NFC_REACHED_WITH_ERROR_SQL).bind(arrivedIso, arrivedIso, message))
  }
  await db.batch(writes)

  const res: TapResponse = { ok: status === 200, action, item: itemOut, local_day: today, message }
  return json(res, status)
}

// ---- phrasing (short strings for a phone banner)

export function durationText(min: number | null): string {
  if (min === null) return '?'
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export function lateText(lateMin: number): string {
  if (lateMin > 0) return `+${lateMin} min`
  if (lateMin < 0) return `${lateMin} min`
  return 'on time'
}

type HHMM = (ts: string | null | undefined) => string

function bedMessage(r: BedTapResult, hhmm: HHMM, streak: number): string {
  const row = r.row
  switch (r.action) {
    case 'bed':
      return `In bed ${hhmm(row?.bed_ts)} (${lateText(row?.late_min ?? 0)}) · streak ${streak}`
    case 'bed_duplicate':
      return `Already in bed ${hhmm(row?.bed_ts)}`
    case 'bed_ignored':
      return `Bedtime stays ${hhmm(row?.bed_ts)} (${lateText(row?.late_min ?? 0)})`
    case 'bed_daytime_ignored':
      return 'Daytime tap ignored · log naps in the app'
    case 'wake':
      return `Up ${hhmm(row?.wake_ts)} · ${durationText(row ? sleepDurationMin(row) : null)}`
    case 'wake_duplicate':
      return `Already up ${hhmm(row?.wake_ts)}`
    case 'nap_then_bed':
      return `Nap ${hhmm(r.nap?.start)}-${hhmm(r.nap?.end)} · In bed ${hhmm(row?.bed_ts)} (${lateText(row?.late_min ?? 0)}) · streak ${streak}`
  }
}

function routineMessage(item: RoutineItem, action: TapAction, row: RoutineLog, hhmm: HHMM): string {
  switch (action) {
    case 'routine_started':
      return `${item.name} started ${hhmm(row.started_at)}`
    case 'routine_finished':
      return `${item.name} done · ${durationText(routineDurationMin(row, item.default_min))}`
    case 'routine_duplicate':
      return `${item.name} already started ${hhmm(row.started_at)}`
    case 'routine_ignored':
      return `${item.name} started ${hhmm(row.started_at)} · tap again after 3 min`
    case 'routine_already_done':
      return `${item.name} already done · ${durationText(routineDurationMin(row, item.default_min))}`
    default:
      return `${item.name}: ${action}`
  }
}
