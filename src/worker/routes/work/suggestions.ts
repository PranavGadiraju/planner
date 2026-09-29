// GET /api/work/suggestions?day=YYYY-MM-DD|today (app) — Mac-derived "log this as a session?" ranges for one local
// day, plus what the app needs to log one: the live projects and the project of the most recent session (the
// default chip). One D1 batch: the same loader as GET /api/day with the last-project lookup riding along.
import type { RouteContext } from '../../env'
import { json } from '../../http'
import { loadDayInput, type DayProject } from '../day'
import { rows } from './db'
import { parseDay } from './parse'
import { suggestSessions, type Suggestion } from './suggest'

export interface SuggestionsPayload {
  day: string
  suggestions: Suggestion[]
  projects: DayProject[]
  /** The project of the most recent session (any day), or null when none was ever logged. */
  last_project_id: string | null
}

const LAST_PROJECT_SQL =
  'SELECT s.project_id FROM sessions s JOIN projects p ON p.id = s.project_id ' +
  'WHERE s.deleted_at IS NULL AND p.deleted_at IS NULL ORDER BY s.started_at DESC LIMIT 1'

export async function suggestions(c: RouteContext): Promise<Response> {
  const { env, now, url } = c
  const day = parseDay(url.searchParams.get('day'), now, env.TZ)
  const { input, projects, extra } = await loadDayInput(env, day, now, [env.DB.prepare(LAST_PROJECT_SQL)])
  const last = rows<{ project_id: string }>(extra[0])[0]?.project_id ?? null
  const payload: SuggestionsPayload = { day, suggestions: suggestSessions(input), projects, last_project_id: last }
  return json(payload)
}
