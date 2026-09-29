// planner Worker: /api/* JSON router + nightly cron; everything else is the PWA's static assets.
import type { Env, Route } from './env'
import type { Role } from '../shared/types'
import { bearerToken, roleForToken } from './auth'
import { HttpError, error, errorMessage } from './http'
import { matchRoute } from './router'
import { health } from './routes/health'
import { me } from './routes/me'
import { tap } from './routes/tap'
import { write } from './routes/write'
import { today } from './routes/today'
import { day } from './routes/day'
import { routineItems } from './routes/routine'
import { automations, tapLog } from './routes/taplog'
import { settings } from './routes/settings'
import { foodRoutes } from './routes/food'
import { liftRoutes } from './routes/lift'
import { workRoutes } from './routes/work'
import { screentimeRoutes } from './routes/screentime'
import { rollupRoutes } from './routes/rollup'
import { runScheduled } from './cron'

const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/api/health', roles: [], handler: health },
  { method: 'GET', path: '/api/me', roles: ['app'], handler: me },
  { method: 'POST', path: '/api/tap', roles: ['shortcut', 'app'], handler: tap },
  { method: 'POST', path: '/api/write', roles: ['app'], handler: write },
  { method: 'GET', path: '/api/today', roles: ['app'], handler: today },
  { method: 'GET', path: '/api/day/:date', roles: ['app'], handler: day },
  { method: 'GET', path: '/api/routine-items', roles: ['app'], handler: routineItems },
  { method: 'GET', path: '/api/tap/log', roles: ['app'], handler: tapLog },
  { method: 'GET', path: '/api/health/automations', roles: ['app'], handler: automations },
  { method: 'GET', path: '/api/settings', roles: ['app'], handler: settings },
  ...foodRoutes, // M3: /api/foods, /api/meals, /api/food-log, /api/lookup/*
  ...liftRoutes, // M4: /api/exercises, /api/workouts, /api/sets
  ...workRoutes, // M5: /api/projects, /api/sessions, /api/time-blocks
  ...screentimeRoutes, // M6: POST /api/screentime, app categories
  ...rollupRoutes, // M7: /api/summary, /api/rollup, /api/cron/run, /api/export
]

async function handleApi(request: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const now = new Date()
  const path = url.pathname.replace(/\/+$/, '') || '/'
  const { route, params, pathMatched } = matchRoute(ROUTES, request.method, path)
  if (route && route.roles.length === 0) return route.handler({ request, env, url, role: null, now, ctx, params })

  const role = await roleForToken(bearerToken(request), { app: env.APP_TOKEN, shortcut: env.SHORTCUT_TOKEN, mac: env.MAC_TOKEN })
  if (!role) return error(401, 'unauthorized')
  if (!route) return pathMatched ? error(405, 'method not allowed') : error(404, 'not found')
  if (!route.roles.includes(role)) return error(403, 'forbidden')
  return route.handler({ request, env, url, role, now, ctx, params })
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
    try {
      return await handleApi(request, env, url, ctx)
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message, e.extra)
      console.error('unhandled', e)
      return error(500, errorMessage(e))
    }
  },
  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduled(env, controller))
  },
} satisfies ExportedHandler<Env>
