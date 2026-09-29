// M6 screen time: POST /api/screentime (Mac script hourly, phone rows from the CLI) and GET /api/apps (category
// triage list). Spread into ROUTES in ../index.ts. Validation and the SQL plan live in ./screentime/payload.ts.
import type { Route, RouteContext } from '../env'
import { HttpError, json, readJson } from '../http'
import type { AppCategoryRow } from '../../shared/types'
import { MAX_SCREENTIME_BODY, parseScreentimeBody, planScreentime } from './screentime/payload'

export interface ScreentimeResponse { hours: number; intervals: number; apps_new: number; days: string[] }

/**
 * POST /api/screentime (mac: source 'mac' only; app: 'mac' or 'phone'). Replaces the (source, device) rows inside
 * the window, bumps app_categories.seen_seconds, marks automation_health and dirty_days, all in ONE D1 batch
 * (transactional: a rejected or failed body never leaves a half-wiped window).
 */
const MAC_ERROR_SQL =
  "INSERT INTO automation_health (source, last_error_at, last_error) VALUES ('mac', ?, ?) " +
  'ON CONFLICT(source) DO UPDATE SET last_error_at = excluded.last_error_at, last_error = excluded.last_error'

export async function screentime(c: RouteContext): Promise<Response> {
  try {
    return await screentimeInner(c)
  } catch (e) {
    // A misconfigured script must show up on Today's health strip, not just as a growing "last push" age.
    if (e instanceof HttpError && c.role === 'mac') {
      await c.env.DB.prepare(MAC_ERROR_SQL).bind(c.now.toISOString(), e.message.slice(0, 200)).run().catch(() => undefined)
    }
    throw e
  }
}

async function screentimeInner(c: RouteContext): Promise<Response> {
  const body = await readJson<unknown>(c.request, MAX_SCREENTIME_BODY)
  const payload = parseScreentimeBody(body, c.role ?? 'shortcut')
  const plan = planScreentime(payload, c.now, c.env.TZ)
  const db = c.env.DB
  const results = await db.batch([...plan.lookups, ...plan.writes].map((s) => db.prepare(s.sql).bind(...s.params)))

  // The lookups run first inside the batch, so they see app_categories as it was before the upserts.
  const existing = new Set<string>()
  for (let i = 0; i < plan.lookups.length; i++) {
    for (const r of (results[i]?.results ?? []) as { app_id: string }[]) existing.add(r.app_id)
  }
  const res: ScreentimeResponse = {
    hours: payload.hours.length,
    intervals: payload.intervals.length,
    apps_new: plan.apps.filter((a) => !existing.has(a.app_id)).length,
    days: plan.days,
  }
  return json(res)
}

/** Uncategorised first (most seen on top), then everything else by seen time. */
export const APPS_SQL =
  'SELECT app_id, label, category, seen_seconds, updated_at, deleted_at FROM app_categories WHERE deleted_at IS NULL ' +
  'ORDER BY CASE WHEN category IS NULL THEN 0 ELSE 1 END, seen_seconds DESC, app_id'

/** GET /api/apps (app) — every live app_categories row; the app edits categories through /api/write. */
export async function apps({ env }: RouteContext): Promise<Response> {
  const { results } = await env.DB.prepare(APPS_SQL).all<AppCategoryRow>()
  return json({ apps: results })
}

export const screentimeRoutes: readonly Route[] = [
  { method: 'POST', path: '/api/screentime', roles: ['mac', 'app'], handler: screentime },
  { method: 'GET', path: '/api/apps', roles: ['app'], handler: apps },
]
