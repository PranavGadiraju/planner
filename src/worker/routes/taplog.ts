import type { RouteContext } from '../env'
import { json } from '../http'
import type { HealthRow } from '../../shared/types'

export interface TapLogRow { id: number; ts: string; item: string; role: string; result: string }

/** GET /api/tap/log (app) — the last 100 sticker taps, newest first. */
export async function tapLog({ env }: RouteContext): Promise<Response> {
  const { results } = await env.DB
    .prepare('SELECT id, ts, item, role, result FROM tap_log ORDER BY id DESC LIMIT 100')
    .all<TapLogRow>()
  return json({ taps: results })
}

export const HEALTH_SQL = 'SELECT source, last_ok_at, last_error_at, last_error, detail FROM automation_health ORDER BY source'

/** GET /api/health/automations (app) — one row per automation source. */
export async function automations({ env }: RouteContext): Promise<Response> {
  const { results } = await env.DB.prepare(HEALTH_SQL).all<HealthRow>()
  return json({ rows: results })
}
