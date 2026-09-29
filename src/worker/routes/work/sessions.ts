// GET /api/sessions?from&to (list + SQL sums) and POST /api/sessions (the `planner session add` helper).
import type { RouteContext } from '../../env'
import { json, readJson } from '../../http'
import { upsertFor } from '../../db'
import { localDay } from '../../../shared/tz'
import type { Session } from '../../../shared/types'
import { dirtyStmts, liveProjects, newProjectStmt, rows } from './db'
import { matchProject, parseRange, parseSessionBody } from './parse'

export const MAX_LIST_ROWS = 1000

const LIST_SQL =
  "SELECT s.*, COALESCE(p.name, 'Session') AS project_name FROM sessions s LEFT JOIN projects p ON p.id = s.project_id " +
  'WHERE s.local_day >= ? AND s.local_day <= ? AND s.deleted_at IS NULL ORDER BY s.started_at DESC LIMIT ?'
const BY_PROJECT_SQL =
  'SELECT project_id AS k, SUM(duration_s) AS seconds FROM sessions ' +
  'WHERE local_day >= ? AND local_day <= ? AND deleted_at IS NULL AND ended_at IS NOT NULL GROUP BY project_id'
const BY_DAY_SQL =
  'SELECT local_day AS k, SUM(duration_s) AS seconds FROM sessions ' +
  'WHERE local_day >= ? AND local_day <= ? AND deleted_at IS NULL AND ended_at IS NOT NULL GROUP BY local_day'

function sums(r: D1Result<unknown> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const row of rows<{ k: string; seconds: number | null }>(r)) out[row.k] = Number(row.seconds) || 0
  return out
}

/**
 * GET /api/sessions?from=YYYY-MM-DD&to=YYYY-MM-DD (app) — sessions whose local_day is in [from, to] (running ones
 * included, newest first) with SQL sums of duration_s per project and per day (running sessions excluded).
 */
export async function sessions(c: RouteContext): Promise<Response> {
  const { env, now, url } = c
  const { from, to } = parseRange(url.searchParams.get('from'), url.searchParams.get('to'), now, env.TZ)
  const db = env.DB
  const [listR, byProjectR, byDayR] = await db.batch([
    db.prepare(LIST_SQL).bind(from, to, MAX_LIST_ROWS),
    db.prepare(BY_PROJECT_SQL).bind(from, to),
    db.prepare(BY_DAY_SQL).bind(from, to),
  ])
  return json({
    from,
    to,
    sessions: rows<Session & { project_name: string }>(listR),
    by_project: sums(byProjectR),
    by_day: sums(byDayR),
  })
}

/**
 * POST /api/sessions (app; the Claude Code helper) — {project: name|id, minutes | start+end (ISO or local 'HH:MM'),
 * note?, day?} -> 201 {session, project, created_project}. An unknown project name is created (case-insensitive
 * match first); local_day is the day of started_at in env.TZ.
 */
export async function addSession(c: RouteContext): Promise<Response> {
  const { env, now } = c
  const tz = env.TZ
  const body = parseSessionBody(await readJson<unknown>(c.request), now, tz)
  const db = env.DB
  const nowIso = now.toISOString()
  const today = localDay(now, tz)

  const known = matchProject(await liveProjects(db), body.project)
  const projectId = known?.id ?? crypto.randomUUID()
  const projectName = known?.name ?? body.project
  const row: Session = {
    id: crypto.randomUUID(),
    project_id: projectId,
    started_at: body.span.started_at,
    ended_at: body.span.ended_at,
    local_day: body.span.local_day,
    duration_s: body.span.duration_s,
    note: body.note,
    source: 'cli',
    ended_by: 'user',
    created_at: nowIso,
    updated_at: nowIso,
    deleted_at: null,
  }
  const up = upsertFor('sessions', row, false)
  await db.batch([
    ...(known ? [] : [newProjectStmt(db, projectId, projectName, nowIso)]),
    db.prepare(up.sql).bind(...up.params),
    ...dirtyStmts(db, [row.local_day], today, nowIso),
  ])
  return json(
    {
      session: { ...row, project_name: projectName },
      project: { id: projectId, name: projectName },
      created_project: !known,
    },
    201,
  )
}
