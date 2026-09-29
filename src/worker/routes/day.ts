// GET /api/day/:date — the live 24-hour timeline for one local day. Every source is loaded in ONE D1 batch and
// handed to the shared buildDay (one pass over <= 1500 minute cells), so the handler stays well inside 10 ms CPU.
// The loader (loadDayInput) is shared with the rollups (src/worker/rollup.ts), which append their own aggregate
// statements to the same batch.
import type { Env, RouteContext } from '../env'
import { HttpError, json } from '../http'
import { parseDayParam } from '../router'
import { addDays, dayWindow } from '../../shared/tz'
import { buildDay } from '../../shared/day'
import type { DayInput, DayResult, ScreenHour, ScreenInterval } from '../../shared/day'
import type { AppCategoryRow, DayFreshness, FoodLog, RoutineItem, RoutineLog, Session, Sleep, TimeBlock, Workout } from '../../shared/types'

export interface DayProject { id: string; name: string; color: string | null }

/** buildDay's result plus what the client needs to label blocks: active routine items and live projects. */
export interface DayPayload extends DayResult {
  routine_items: RoutineItem[]
  projects: DayProject[]
  /** Live manual rows overlapping the window, so the app can edit or delete a block. */
  time_blocks: TimeBlock[]
  /** "Mac last pushed 4 h ago · phone none today" for the foot of the view. */
  freshness: DayFreshness
}

/** Three cheap MAX()/lookup statements that ride in the day batch (no extra round trip). */
function freshnessStatements(db: D1Database): D1PreparedStatement[] {
  return [
    db.prepare("SELECT MAX(hour_start) AS h FROM screen_hours WHERE source = 'mac'"),
    db.prepare("SELECT MAX(hour_start) AS h FROM screen_hours WHERE source = 'phone'"),
    db.prepare("SELECT last_ok_at AS h FROM automation_health WHERE source = 'mac'"),
  ]
}

function tsOf(r: D1Result<unknown> | undefined): string | null {
  const v = (rows<{ h: unknown }>(r)[0] ?? {}).h
  return typeof v === 'string' ? v : null
}

/** Everything buildDay needs for one day, plus the rows the API exposes next to the result. */
export interface DayInputBundle {
  input: DayInput
  /** Every non-deleted routine item (active or not), so old logs keep their name and category. */
  items: RoutineItem[]
  projects: DayProject[]
  /** Results of the `extra` statements handed to loadDayInput, in order. */
  extra: D1Result<unknown>[]
}

function rows<T>(r: D1Result<unknown> | undefined): T[] {
  return (r?.results ?? []) as T[]
}

const SOURCE_STATEMENTS = 11

/** The per-source SELECTs for one local day, in the order parseDayInput expects them. */
function sourceStatements(db: D1Database, date: string, tz: string): D1PreparedStatement[] {
  const { start, end } = dayWindow(date, tz)
  const startIso = start.toISOString()
  const endIso = end.toISOString()
  // Hour buckets are UTC hours; local midnight can sit inside one, so take the hour before the window too.
  const hourFloorIso = new Date(start.getTime() - 3600_000).toISOString()
  return [
    db.prepare('SELECT * FROM time_blocks WHERE start_ts < ? AND end_ts > ? AND deleted_at IS NULL ORDER BY start_ts').bind(endIso, startIso),
    db.prepare('SELECT * FROM sleep WHERE night_of IN (?, ?) AND deleted_at IS NULL ORDER BY night_of').bind(addDays(date, -1), date),
    db.prepare(
      'SELECT * FROM workouts WHERE started_at < ? AND (ended_at IS NULL OR ended_at > ?) AND deleted_at IS NULL ORDER BY started_at',
    ).bind(endIso, startIso),
    db.prepare(
      'SELECT s.*, p.name AS project_name FROM sessions s LEFT JOIN projects p ON p.id = s.project_id ' +
        'WHERE s.started_at < ? AND (s.ended_at IS NULL OR s.ended_at > ?) AND s.deleted_at IS NULL ORDER BY s.started_at',
    ).bind(endIso, startIso),
    db.prepare('SELECT * FROM routine_log WHERE local_day = ? AND deleted_at IS NULL').bind(date),
    // Active or not: an old log must still get its item's name and category.
    db.prepare('SELECT * FROM routine_items WHERE deleted_at IS NULL ORDER BY position, id'),
    db.prepare(
      "SELECT source, device, start_ts, end_ts, top_app FROM screen_intervals WHERE source IN ('mac', 'phone') AND start_ts < ? AND end_ts > ? ORDER BY start_ts",
    ).bind(endIso, startIso),
    db.prepare('SELECT source, device, hour_start, app_id, seconds FROM screen_hours WHERE hour_start >= ? AND hour_start < ?').bind(hourFloorIso, endIso),
    db.prepare('SELECT app_id, label, category FROM app_categories WHERE deleted_at IS NULL'),
    db.prepare('SELECT ts, label, kcal, slot FROM food_log WHERE local_day = ? AND deleted_at IS NULL ORDER BY ts').bind(date),
    db.prepare('SELECT id, name, color FROM projects WHERE deleted_at IS NULL ORDER BY position, id'),
  ]
}

/**
 * Load every buildDay source for `date` in one D1 batch. `extra` statements ride in the same batch and come back
 * as `extra` results (the rollup uses this for its SQL sums), so a rebuild costs one read batch and one write batch.
 */
export async function loadDayInput(env: Env, date: string, now: Date, extra: D1PreparedStatement[] = []): Promise<DayInputBundle> {
  const tz = env.TZ
  const results = await env.DB.batch([...sourceStatements(env.DB, date, tz), ...extra])
  const [blocksR, sleepR, workoutsR, sessionsR, logR, itemsR, intervalsR, hoursR, catsR, foodR, projectsR] = results
  const items = rows<RoutineItem>(itemsR)
  const input: DayInput = {
    day: date,
    tz,
    now,
    time_blocks: rows<TimeBlock>(blocksR),
    sleep: rows<Sleep>(sleepR),
    workouts: rows<Workout>(workoutsR),
    sessions: rows<Session & { project_name: string | null }>(sessionsR),
    routine_log: rows<RoutineLog>(logR),
    routine_items: items,
    screen_intervals: rows<ScreenInterval>(intervalsR),
    screen_hours: rows<ScreenHour>(hoursR),
    app_categories: rows<Pick<AppCategoryRow, 'app_id' | 'label' | 'category'>>(catsR),
    food_log: rows<Pick<FoodLog, 'ts' | 'label' | 'kcal' | 'slot'>>(foodR),
  }
  return { input, items, projects: rows<DayProject>(projectsR), extra: results.slice(SOURCE_STATEMENTS) }
}

export async function day(c: RouteContext): Promise<Response> {
  const { env, now } = c
  const date = parseDayParam(c.params['date'] ?? '', now, env.TZ)
  if (!date) throw new HttpError(400, 'date must be YYYY-MM-DD or today')
  const { input, items, projects, extra } = await loadDayInput(env, date, now, freshnessStatements(env.DB))
  const [macR, phoneR, macOkR] = extra
  const payload: DayPayload = {
    ...buildDay(input),
    routine_items: items.filter((i) => Number(i.active) === 1),
    projects,
    time_blocks: input.time_blocks,
    freshness: { mac_last_hour: tsOf(macR), phone_last_hour: tsOf(phoneR), mac_last_ok_at: tsOf(macOkR) },
  }
  return json(payload)
}
