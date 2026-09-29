// GET /api/work/week?day=YYYY-MM-DD — this week and last week (Mon-Sun in env.TZ) as per-day, per-project seconds.
import type { RouteContext } from '../../env'
import { json } from '../../http'
import { addDays, weekStart } from '../../../shared/tz'
import { LIVE_PROJECTS_SQL, rows, type LiveProject } from './db'
import { groupWeek, parseDay, type WeekRow } from './parse'

const WEEK_SQL =
  'SELECT local_day, project_id, SUM(duration_s) AS seconds FROM sessions ' +
  'WHERE local_day >= ? AND local_day < ? AND deleted_at IS NULL AND ended_at IS NOT NULL GROUP BY local_day, project_id'

/**
 * GET /api/work/week?day= (app) — {day, week_start, days[7], last_week: {week_start, days[7]}, projects}. One
 * grouped query over the 14 days; running sessions are not counted. `projects` labels the bars (archived included).
 */
export async function workWeek(c: RouteContext): Promise<Response> {
  const { env, now, url } = c
  const day = parseDay(url.searchParams.get('day'), now, env.TZ)
  const start = weekStart(day)
  const lastStart = addDays(start, -7)
  const db = env.DB
  const [rowsR, projectsR] = await db.batch([
    db.prepare(WEEK_SQL).bind(lastStart, addDays(start, 7)),
    db.prepare(LIVE_PROJECTS_SQL),
  ])
  const all = rows<WeekRow>(rowsR)
  return json({
    day,
    week_start: start,
    days: groupWeek(all, start),
    last_week: { week_start: lastStart, days: groupWeek(all, lastStart) },
    projects: rows<LiveProject>(projectsR),
  })
}
