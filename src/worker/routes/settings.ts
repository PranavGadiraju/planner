import type { RouteContext } from '../env'
import { loadSettings } from '../db'
import { json } from '../http'

/** GET /api/settings (app) — parsed settings with defaults filled. Writes go through /api/write (table settings). */
export async function settings({ env }: RouteContext): Promise<Response> {
  return json(await loadSettings(env.DB))
}
