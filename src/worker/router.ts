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

// Zoned ISO-8601 only: YYYY-MM-DDTHH:MM[:SS[.fff]] followed by Z or an offset. `new Date(s)` alone also swallows
// V8's legacy forms ('12' -> 2001-12-01, '2026-09-28' -> UTC midnight, 'Sep 28 2026 10:00' and a zone-less
// 'YYYY-MM-DDTHH:MM' read in the Worker's UTC) and rolls 2026-02-30 or 24:00 over to the next day; none of those
// is what a typo meant, so they are refused instead of landing a row on the wrong day.
const ISO_ZONED = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/

/** A zoned ISO-8601 instant (2026-09-28T10:00:00Z, 2026-09-28T06:00-04:00) on a real calendar day, else null. */
export function parseIso(s: string): Date | null {
  const m = ISO_ZONED.exec(s)
  if (!m || !isCalendarDay(m[1] ?? '') || Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4] ?? 0) > 59) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** A ':date' path parameter -> local day: 'today' (in tz, at `now`) or a valid YYYY-MM-DD; null when it is neither. */
export function parseDayParam(raw: string, now: Date, tz: string): string | null {
  const v = raw.trim().toLowerCase()
  if (v === 'today') return localDay(now, tz)
  return isCalendarDay(v) ? v : null
}
