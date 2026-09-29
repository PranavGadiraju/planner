// M7 rollups (role app): GET /api/summary?from&to, POST /api/rollup {day}, POST /api/cron/run, GET /api/export.
// Spread into ROUTES in ../index.ts. Range planning is pure in ./rollup/range.ts; the row math in ./rollup/summary.ts.
import type { Route, RouteContext } from '../env'
import { HttpError, isRecord, json, readJson } from '../http'
import { isCalendarDay, parseDayParam } from '../router'
import { addDays, localDay } from '../../shared/tz'
import { runScheduled } from '../cron'
import { SUMMARY_SELECT_SQL, computeSummary, emptySummary, rebuildDay, rowToSummary } from '../rollup'
import type { DaySummary, DaySummaryRow } from '../rollup'
import type { DayProject } from './day'
import { exportAll } from './rollup/export'
import { dayRange, parseRange, planRange } from './rollup/range'

/** A summary as /api/summary returns it: `live` for today (computed, never stored), `stale` for a day still waiting for a rebuild. */
export type SummaryDay = DaySummary & { live?: true; stale?: true }

export interface SummaryResponse {
  from: string
  to: string
  today: string
  days: SummaryDay[]
  /** Live projects, so the client can name the study_by_project keys. */
  projects: DayProject[]
  /** Earliest local day with any data; days before it are "no data", never stale, never rebuilt. */
  first_day: string | null
}

// One row of scalar subqueries (D1 caps the number of terms in a compound SELECT); the minimum is taken in JS.
const FIRST_DAY_SQL =
  'SELECT (SELECT MIN(local_day) FROM routine_log) AS a, (SELECT MIN(night_of) FROM sleep) AS b, ' +
  '(SELECT MIN(local_day) FROM food_log) AS c, (SELECT MIN(local_day) FROM workouts) AS d, ' +
  '(SELECT MIN(local_day) FROM sessions) AS e, (SELECT MIN(local_day) FROM day_summary) AS f'

/** GET /api/summary?from&to (app) */
export async function summary(c: RouteContext): Promise<Response> {
  const { env, now, url } = c
  const tz = env.TZ
  const { from, to } = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), now, tz)
  const today = localDay(now, tz)
  const db = env.DB
  const [rowsR, dirtyR, projectsR, firstR] = await db.batch([
    db.prepare(SUMMARY_SELECT_SQL).bind(from, to),
    db.prepare('SELECT local_day FROM dirty_days WHERE local_day >= ? AND local_day <= ?').bind(from, to),
    db.prepare('SELECT id, name, color FROM projects WHERE deleted_at IS NULL ORDER BY position, id'),
    db.prepare(FIRST_DAY_SQL),
  ])
  const firstRow = (firstR?.results ?? [])[0] as Record<string, string | null> | undefined
  const firstDays = Object.values(firstRow ?? {}).filter((v): v is string => typeof v === 'string').sort()
  const firstDay = firstDays[0] ?? null
  const stored = new Map<string, DaySummary>()
  for (const r of (rowsR?.results ?? []) as DaySummaryRow[]) stored.set(r.local_day, rowToSummary(r))
  const dirty = new Set(((dirtyR?.results ?? []) as { local_day: string }[]).map((r) => r.local_day))

  const days = dayRange(from, to)
  // Days before the first data day are empty by definition: no stale flag, no rebuild budget spent on them.
  const before = firstDay ? days.filter((d) => d < firstDay) : []
  const plan = planRange(firstDay ? days.filter((d) => d >= firstDay) : days, stored, dirty, today)
  const out = new Map<string, SummaryDay>()
  for (const d of before) out.set(d, emptySummary(d))
  for (const d of [...plan.final, ...plan.asIs]) out.set(d, stored.get(d) ?? emptySummary(d))
  for (const d of plan.stale) out.set(d, { ...(stored.get(d) ?? emptySummary(d)), stale: true })
  // Live today and the (<= 3) rebuilds run side by side: D1 latency is wall-clock, the work itself is small.
  const [live, ...rebuilt] = await Promise.all([
    plan.live ? computeSummary(env, plan.live, now) : Promise.resolve(null),
    ...plan.recompute.map((d) => rebuildDay(env, d, now)),
  ])
  if (live && plan.live) out.set(plan.live, { ...live, live: true })
  for (const s of rebuilt) out.set(s.local_day, s)

  const res: SummaryResponse = {
    from, to, today,
    days: days.filter((d) => out.has(d)).map((d) => out.get(d) as SummaryDay),
    projects: (projectsR?.results ?? []) as DayProject[],
    first_day: firstDay,
  }
  return json(res)
}

/** POST /api/rollup {day} (app): rebuild one past day now (today is always computed live and never stored). */
export async function rollup(c: RouteContext): Promise<Response> {
  const { env, now } = c
  const body = await readJson<unknown>(c.request)
  if (!isRecord(body)) throw new HttpError(400, 'body must be a JSON object')
  const raw = typeof body['day'] === 'string' ? body['day'].trim() : ''
  const today = localDay(now, env.TZ)
  const day = raw.toLowerCase() === 'yesterday' ? addDays(today, -1) : parseDayParam(raw, now, env.TZ)
  if (!day || !isCalendarDay(day)) throw new HttpError(400, 'day must be YYYY-MM-DD, today or yesterday')
  if (day > today) throw new HttpError(400, 'day is in the future')
  if (day === today) throw new HttpError(400, 'today is computed live; rebuild yesterday or earlier')
  const s = await rebuildDay(env, day, now)
  return json({ day, summary: s })
}

/** POST /api/cron/run (app): the nightly work, on demand, for verification. */
export async function cronRun(c: RouteContext): Promise<Response> {
  const report = await runScheduled(c.env)
  return json({ ok: true, ...report })
}

export const rollupRoutes: readonly Route[] = [
  { method: 'GET', path: '/api/summary', roles: ['app'], handler: summary },
  { method: 'POST', path: '/api/rollup', roles: ['app'], handler: rollup },
  { method: 'POST', path: '/api/cron/run', roles: ['app'], handler: cronRun },
  { method: 'GET', path: '/api/export', roles: ['app'], handler: exportAll },
]
