import type { RouteContext } from '../env'
import { json } from '../http'
import { localDay } from '../../shared/tz'

/** GET /api/health (public) — liveness, used when setting up the Shortcut. */
export async function health({ env, now }: RouteContext): Promise<Response> {
  return json({ ok: true, version: env.APP_VERSION, time: now.toISOString(), today: localDay(now, env.TZ) })
}
