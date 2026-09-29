import type { RouteContext } from '../env'
import { json } from '../http'
import type { RoutineItem } from '../../shared/types'

/**
 * GET /api/routine-items (app) — every routine item for the editor: inactive ones included, and tombstones too so a
 * device's cached list drops items deleted elsewhere (the app merges by updated_at and filters deleted_at itself).
 */
export async function routineItems({ env }: RouteContext): Promise<Response> {
  const { results } = await env.DB.prepare('SELECT * FROM routine_items ORDER BY position, id').all<RoutineItem>()
  return json({ items: results })
}
