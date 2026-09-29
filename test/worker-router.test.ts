import { describe, expect, it } from 'vitest'
import { isCalendarDay, matchPath, matchRoute, parseDayParam } from '../src/worker/router'

const TZ = 'America/New_York'

describe('matchPath', () => {
  it('literal patterns need an exact match', () => {
    expect(matchPath('/api/today', '/api/today')).toEqual({})
    expect(matchPath('/api/today', '/api/today/x')).toBeNull()
    expect(matchPath('/api/today', '/api/toda')).toBeNull()
    expect(matchPath('/api/today', '/api/Today')).toBeNull()
  })
  it('captures one segment per :param and percent-decodes it', () => {
    expect(matchPath('/api/day/:date', '/api/day/2026-09-28')).toEqual({ date: '2026-09-28' })
    expect(matchPath('/api/day/:date', '/api/day/to%20day')).toEqual({ date: 'to day' })
    expect(matchPath('/api/projects/:id/log', '/api/projects/p1/log')).toEqual({ id: 'p1' })
  })
  it('rejects missing, empty, extra and undecodable segments', () => {
    expect(matchPath('/api/day/:date', '/api/day')).toBeNull()
    expect(matchPath('/api/day/:date', '/api/day/')).toBeNull()
    expect(matchPath('/api/day/:date', '/api/day/2026-09-28/extra')).toBeNull()
    expect(matchPath('/api/day/:date', '/api/day/%E0%A4%A')).toBeNull()
    expect(matchPath('/api/projects/:id/log', '/api/projects/p1/nope')).toBeNull()
  })
})

describe('matchRoute', () => {
  const routes = [
    { method: 'GET', path: '/api/today' },
    { method: 'GET', path: '/api/day/:date' },
    { method: 'GET', path: '/api/tap/log' },
    { method: 'POST', path: '/api/tap' },
    { method: 'GET', path: '/api/tap/:id' },
    { method: 'DELETE', path: '/api/tap/:id' },
  ]
  it('keeps exact-match behaviour for literal routes', () => {
    expect(matchRoute(routes, 'GET', '/api/today')).toEqual({ route: routes[0], params: {}, pathMatched: true })
    expect(matchRoute(routes, 'GET', '/api/nope')).toEqual({ route: null, params: {}, pathMatched: false })
  })
  it('distinguishes 405 (path known, method not) from 404', () => {
    expect(matchRoute(routes, 'POST', '/api/today')).toEqual({ route: null, params: {}, pathMatched: true })
    expect(matchRoute(routes, 'POST', '/api/day/2026-09-28')).toEqual({ route: null, params: {}, pathMatched: true })
    expect(matchRoute(routes, 'PUT', '/api/tap/log')).toMatchObject({ route: null, pathMatched: true })
  })
  it('hands params to the matched parameterised route, per method', () => {
    expect(matchRoute(routes, 'GET', '/api/day/2026-09-28')).toEqual({ route: routes[1], params: { date: '2026-09-28' }, pathMatched: true })
    expect(matchRoute(routes, 'DELETE', '/api/tap/42')).toEqual({ route: routes[5], params: { id: '42' }, pathMatched: true })
  })
  it('a literal path beats a parameterised one for the same request', () => {
    expect(matchRoute(routes, 'GET', '/api/tap/log')).toEqual({ route: routes[2], params: {}, pathMatched: true })
    // and a literal-only method mismatch is a 405 even though a :param route could have matched another method
    expect(matchRoute(routes, 'DELETE', '/api/tap/log')).toEqual({ route: null, params: {}, pathMatched: true })
  })
})

describe('isCalendarDay / parseDayParam', () => {
  it('accepts real dates only', () => {
    expect(isCalendarDay('2026-09-28')).toBe(true)
    expect(isCalendarDay('2024-02-29')).toBe(true)
    expect(isCalendarDay('2026-02-29')).toBe(false)
    expect(isCalendarDay('2026-13-45')).toBe(false)
    expect(isCalendarDay('2026-00-10')).toBe(false)
    expect(isCalendarDay('2026-9-28')).toBe(false)
    expect(isCalendarDay('20260928')).toBe(false)
    expect(isCalendarDay('2026-09-28T00:00:00Z')).toBe(false)
  })
  it("maps 'today' to the local day in tz and passes valid dates through", () => {
    const now = new Date('2026-09-29T03:30:00.000Z') // 23:30 EDT on the 28th
    expect(parseDayParam('today', now, TZ)).toBe('2026-09-28')
    expect(parseDayParam('TODAY', now, TZ)).toBe('2026-09-28')
    expect(parseDayParam('today', now, 'UTC')).toBe('2026-09-29')
    expect(parseDayParam('2026-01-02', now, TZ)).toBe('2026-01-02')
    expect(parseDayParam('2026-13-45', now, TZ)).toBeNull()
    expect(parseDayParam('yesterday', now, TZ)).toBeNull()
    expect(parseDayParam('', now, TZ)).toBeNull()
  })
})
