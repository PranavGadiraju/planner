// Path matching for the ROUTES table and URL-parameter parsing. Pure (no D1 or Worker globals) so vitest can import it.
import { localDay } from '../shared/tz'

export type Params = Record<string, string>

export interface RouteMatch<R> {
  /** The route whose path and method both matched, or null. */
  route: R | null
  params: Params
  /** True when some route matched the path (so a null `route` means 405, not 404). */
  pathMatched: boolean
}

/**
 * Match one route pattern against a request path. A pattern without ':' must equal the path exactly; a pattern
 * segment ':name' captures the corresponding non-empty path segment (percent-decoded) into params.name.
 */
export function matchPath(pattern: string, path: string): Params | null {
  if (!pattern.includes(':')) return pattern === path ? {} : null
  const want = pattern.split('/')
  const got = path.split('/')
  if (want.length !== got.length) return null
  const params: Params = {}
  for (let i = 0; i < want.length; i++) {
    const w = want[i] ?? ''
    const g = got[i] ?? ''
    if (w.startsWith(':')) {
      if (!g) return null
      try {
        params[w.slice(1)] = decodeURIComponent(g)
      } catch {
        return null
      }
    } else if (w !== g) return null
  }
  return params
}

/** Pick the route for (method, path). Literal paths beat parameterised ones, so '/api/tap/log' is never captured by '/api/tap/:id'. */
export function matchRoute<R extends { method: string; path: string }>(routes: readonly R[], method: string, path: string): RouteMatch<R> {
  let candidates: { route: R; params: Params }[] = []
  for (const route of routes) {
    const params = matchPath(route.path, path)
    if (params) candidates.push({ route, params })
  }
  const literal = candidates.filter((c) => !c.route.path.includes(':'))
  if (literal.length) candidates = literal
  const hit = candidates.find((c) => c.route.method === method)
  return { route: hit?.route ?? null, params: hit?.params ?? {}, pathMatched: candidates.length > 0 }
}

/** True for a real calendar date written YYYY-MM-DD (2026-13-45 is not one). */
export function isCalendarDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = new Date(Date.UTC(y, mo - 1, d))
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d
}

/** A ':date' path parameter -> local day: 'today' (in tz, at `now`) or a valid YYYY-MM-DD; null when it is neither. */
export function parseDayParam(raw: string, now: Date, tz: string): string | null {
  const v = raw.trim().toLowerCase()
  if (v === 'today') return localDay(now, tz)
  return isCalendarDay(v) ? v : null
}
