import type { RouteContext } from '../env'
import { json } from '../http'
import { localDay } from '../../shared/tz'

/** GET /api/me (app) — validates the token and tells the client what "today" is on the server. */
export async function me({ env, now, role }: RouteContext): Promise<Response> {
  return json({ role, tz: env.TZ, server_time: now.toISOString(), today: localDay(now, env.TZ) })
}
