// Worker bindings (wrangler.jsonc vars + `wrangler secret put` secrets) and the per-request context handed to routes.
import type { Role } from '../shared/types'

export interface Env {
  DB: D1Database
  ASSETS: Fetcher
  TZ: string
  APP_VERSION: string
  APP_TOKEN: string
  SHORTCUT_TOKEN: string
  MAC_TOKEN: string
  USDA_KEY?: string
}

export interface RouteContext {
  request: Request
  env: Env
  url: URL
  /** null only on public routes (/api/health). */
  role: Role | null
  /** Server time when the request arrived. */
  now: Date
  /** Values captured by ':name' segments of the matched route path (e.g. { date: '2026-09-28' } for /api/day/:date). */
  params: Record<string, string>
}
