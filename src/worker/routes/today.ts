// GET /api/today — everything the Today screen needs, fetched in one D1 batch (counts and maxes done in SQL).
import type { RouteContext } from '../env'
import { json } from '../http'
import { parseSettings, SETTINGS_SQL } from '../db'
import type { SettingsRow } from '../db'
import { addDays, dayWindow, localDay } from '../../shared/tz'
import { bedtimeStreak, nightOf } from '../../shared/sleep'
import type { Checkin, HealthRow, RoutineItem, RoutineLog, Session, Sleep, TodayPayload, Workout } from '../../shared/types'
import { HEALTH_SQL } from './taplog'

function rows<T>(r: D1Result<unknown> | undefined): T[] {
  return (r?.results ?? []) as T[]
}
function one<T>(r: D1Result<unknown> | undefined): T | null {
  return rows<T>(r)[0] ?? null
}
function count(r: D1Result<unknown> | undefined): number {
  return Number(one<{ n: number | null }>(r)?.n ?? 0)
}
function maxTs(r: D1Result<unknown> | undefined): string | null {
  const v = one<{ h: string | null }>(r)?.h
  return typeof v === 'string' ? v : null
}

export async function today(c: RouteContext): Promise<Response> {
  const { env, now } = c
  const tz = env.TZ
  const day = localDay(now, tz)
  const night = nightOf(now, tz)
  const lastNight = addDays(night, -1)
  const { start, end } = dayWindow(day, tz)
  const db = env.DB

  const [settingsR, itemsR, logR, sleepR, checkinR, workoutR, sessionR, healthR, tapsR, macR, phoneR, triageR] = await db.batch([
    db.prepare(SETTINGS_SQL),
    db.prepare('SELECT * FROM routine_items WHERE active = 1 AND deleted_at IS NULL ORDER BY position, id'),
    db.prepare('SELECT * FROM routine_log WHERE local_day = ? AND deleted_at IS NULL').bind(day),
    db.prepare('SELECT * FROM sleep WHERE deleted_at IS NULL ORDER BY night_of DESC LIMIT 60'),
    db.prepare('SELECT * FROM checkins WHERE local_day = ? AND deleted_at IS NULL LIMIT 1').bind(day),
    db.prepare('SELECT * FROM workouts WHERE ended_at IS NULL AND deleted_at IS NULL ORDER BY started_at DESC LIMIT 1'),
    db.prepare(
      'SELECT s.*, p.name AS project_name FROM sessions s JOIN projects p ON p.id = s.project_id ' +
        'WHERE s.ended_at IS NULL AND s.deleted_at IS NULL ORDER BY s.started_at DESC LIMIT 1',
    ),
    db.prepare(HEALTH_SQL),
    db.prepare('SELECT COUNT(*) AS n FROM tap_log WHERE ts >= ? AND ts < ?').bind(start.toISOString(), end.toISOString()),
    db.prepare("SELECT MAX(hour_start) AS h FROM screen_hours WHERE source = 'mac'"),
    db.prepare("SELECT MAX(hour_start) AS h FROM screen_hours WHERE source = 'phone'"),
    db.prepare('SELECT COUNT(*) AS n FROM app_categories WHERE category IS NULL AND deleted_at IS NULL'),
  ])

  const settings = parseSettings(rows<SettingsRow>(settingsR))
  const sleepRows = rows<Sleep>(sleepR)
  const tonight = sleepRows.find((r) => r.night_of === night) ?? null
  const last = sleepRows.find((r) => r.night_of === lastNight) ?? null
  const open = tonight && !tonight.wake_ts ? tonight : last && !last.wake_ts ? last : null

  const payload: TodayPayload = {
    today: day,
    now: now.toISOString(),
    tz,
    settings,
    routine_items: rows<RoutineItem>(itemsR),
    routine_log: rows<RoutineLog>(logR),
    sleep: { tonight, last_night: last, open, streak: bedtimeStreak(sleepRows, settings.late_grace_min, night) },
    checkin: one<Checkin>(checkinR),
    running: { workout: one<Workout>(workoutR), session: one<Session & { project_name: string }>(sessionR) },
    health: {
      rows: rows<HealthRow>(healthR),
      taps_today: count(tapsR),
      mac_last_hour: maxTs(macR),
      phone_last_hour: maxTs(phoneR),
      apps_to_triage: count(triageR),
    },
  }
  return json(payload)
}
