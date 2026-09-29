// GET /api/projects and GET /api/projects/:id/log (the per-project changelog of "what got done").
import type { RouteContext } from '../../env'
import { HttpError, json } from '../../http'
import type { Project, Session } from '../../../shared/types'
import { rows } from './db'

export const MAX_LOG_LIMIT = 500
export const DEFAULT_LOG_LIMIT = 100

/** GET /api/projects (app) — every non-deleted project, archived ones included (archived_at set), by position then name. */
export async function projects({ env }: RouteContext): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT * FROM projects WHERE deleted_at IS NULL ORDER BY position, name').all<Project>()
  return json({ projects: results })
}

export interface LogEntry {
  id: string
  local_day: string
  started_at: string
  ended_at: string | null
  duration_s: number | null
  note: string | null
  source: Session['source']
}

/** GET /api/projects/:id/log?limit=100 (app) — that project's sessions newest first, plus its all-time total. */
export async function projectLog(c: RouteContext): Promise<Response> {
  const { env, url } = c
  const id = c.params['id'] ?? ''
  const rawLimit = url.searchParams.get('limit')
  let limit = DEFAULT_LOG_LIMIT
  if (rawLimit !== null && rawLimit !== '') {
    const n = Number(rawLimit)
    if (!Number.isInteger(n) || n < 1 || n > MAX_LOG_LIMIT) throw new HttpError(400, `limit must be an integer between 1 and ${MAX_LOG_LIMIT}`)
    limit = n
  }
  const db = env.DB
  const [projectR, entriesR, totalR] = await db.batch([
    db.prepare('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL').bind(id),
    db
      .prepare(
        'SELECT id, local_day, started_at, ended_at, duration_s, note, source FROM sessions ' +
          'WHERE project_id = ? AND deleted_at IS NULL ORDER BY started_at DESC LIMIT ?',
      )
      .bind(id, limit),
    db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(duration_s), 0) AS seconds FROM sessions WHERE project_id = ? AND deleted_at IS NULL AND ended_at IS NOT NULL')
      .bind(id),
  ])
  const project = rows<Project>(projectR)[0]
  if (!project) throw new HttpError(404, 'project not found')
  const total = rows<{ n: number; seconds: number }>(totalR)[0]
  return json({
    project,
    entries: rows<LogEntry>(entriesR),
    count: Number(total?.n ?? 0),
    total_s: Number(total?.seconds ?? 0),
    limit,
  })
}
