import { describe, expect, it } from 'vitest'
import {
  appsSeen, daysTouched, floorHourIso, HEALTH_SQL, DIRTY_SQL, isPseudoApp, MAX_BINDINGS, normIso, parseScreentimeBody, planScreentime,
} from '../src/worker/routes/screentime/payload'
import { HttpError } from '../src/worker/http'

const TZ = 'America/New_York'
const FROM = '2026-09-28T13:00:00.000Z' // 09:00 EDT
const TO = '2026-09-28T15:00:00.000Z'

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: 'mac',
    device: 'mbp',
    window: { from: FROM, to: TO },
    hours: [
      { hour_start: '2026-09-28T13:00:00.000Z', app_id: 'com.apple.Safari', seconds: 900 },
      { hour_start: '2026-09-28T13:00:00.000Z', app_id: 'com.microsoft.VSCode', seconds: 1800 },
      { hour_start: '2026-09-28T14:00:00.000Z', app_id: 'com.microsoft.VSCode', seconds: 3600 },
    ],
    intervals: [
      { start: '2026-09-28T13:05:00.000Z', end: '2026-09-28T13:50:00.000Z', top_app: 'com.microsoft.VSCode' },
      { start: '2026-09-28T14:00:00.000Z', end: '2026-09-28T15:00:00.000Z', top_app: 'com.microsoft.VSCode' },
    ],
    apps: [{ app_id: 'com.apple.Safari', label: 'Safari' }, { app_id: 'com.microsoft.VSCode', label: null }],
    ...over,
  }
}

function rejects(b: unknown, status: number, pattern: RegExp, role: 'mac' | 'app' | 'shortcut' = 'mac'): void {
  try {
    parseScreentimeBody(b, role)
  } catch (e) {
    expect(e).toBeInstanceOf(HttpError)
    const err = e as HttpError
    expect(err.status, err.message).toBe(status)
    expect(err.message).toMatch(pattern)
    return
  }
  throw new Error('expected a rejection')
}

describe('normIso / floorHourIso', () => {
  it('canonicalises any parseable ISO timestamp', () => {
    expect(normIso('2026-09-28T13:00:00Z')).toBe('2026-09-28T13:00:00.000Z')
    expect(normIso('2026-09-28T09:00:00-04:00')).toBe('2026-09-28T13:00:00.000Z')
    expect(normIso('2026-09-28')).toBeNull()
    expect(normIso('yesterday')).toBeNull()
    expect(normIso(12)).toBeNull()
  })
  it('floors to the UTC hour', () => {
    expect(floorHourIso('2026-09-28T13:37:12.345Z')).toBe('2026-09-28T13:00:00.000Z')
  })
  it('treats underscore ids as pseudo apps', () => {
    expect(isPseudoApp('_total')).toBe(true)
    expect(isPseudoApp('com.apple.Safari')).toBe(false)
  })
})

describe('parseScreentimeBody', () => {
  it('accepts the Mac script payload and normalises it', () => {
    const p = parseScreentimeBody(body(), 'mac')
    expect(p.source).toBe('mac')
    expect(p.device).toBe('mbp')
    expect(p.window).toEqual({ from: FROM, to: TO })
    expect(p.hours).toHaveLength(3)
    expect(p.hours[0]).toEqual({ hour_start: '2026-09-28T13:00:00.000Z', app_id: 'com.apple.Safari', seconds: 900 })
    expect(p.intervals).toHaveLength(2)
    expect(p.apps).toEqual([{ app_id: 'com.apple.Safari', label: 'Safari' }, { app_id: 'com.microsoft.VSCode', label: null }])
  })
  it('canonicalises timestamps written without milliseconds or with an offset', () => {
    const p = parseScreentimeBody(body({
      window: { from: '2026-09-28T09:00:00-04:00', to: '2026-09-28T15:00:00Z' },
      hours: [{ hour_start: '2026-09-28T09:00:00-04:00', app_id: 'a', seconds: 1 }],
      intervals: [{ start: '2026-09-28T13:00:00Z', end: '2026-09-28T13:01:00Z', top_app: null }],
    }), 'mac')
    expect(p.window.from).toBe(FROM)
    expect(p.hours[0]?.hour_start).toBe(FROM)
    expect(p.intervals[0]).toEqual({ start: FROM, end: '2026-09-28T13:01:00.000Z', top_app: null })
  })
  it('merges duplicate hour rows (clamped) and collapses intervals with the same start', () => {
    const p = parseScreentimeBody(body({
      hours: [
        { hour_start: FROM, app_id: 'a', seconds: 3000 },
        { hour_start: FROM, app_id: 'a', seconds: 3000 },
      ],
      intervals: [
        { start: FROM, end: '2026-09-28T13:10:00.000Z', top_app: 'a' },
        { start: FROM, end: '2026-09-28T13:20:00.000Z', top_app: 'b' },
      ],
    }), 'mac')
    expect(p.hours).toEqual([{ hour_start: FROM, app_id: 'a', seconds: 3600 }])
    expect(p.intervals).toEqual([{ start: FROM, end: '2026-09-28T13:20:00.000Z', top_app: 'b' }])
  })
  it('intervals and apps are optional', () => {
    const p = parseScreentimeBody(body({ intervals: undefined, apps: undefined }), 'mac')
    expect(p.intervals).toEqual([])
    expect(p.apps).toEqual([])
  })
  it('allows hour rows in the hour that contains window.from', () => {
    const p = parseScreentimeBody(body({ window: { from: '2026-09-28T13:05:00.000Z', to: TO } }), 'mac')
    expect(p.hours[0]?.hour_start).toBe(FROM)
  })
  it('the app role may send phone totals', () => {
    const p = parseScreentimeBody(body({ source: 'phone', device: 'iphone', hours: [{ hour_start: FROM, app_id: '_total', seconds: 1200 }], intervals: [], apps: [] }), 'app')
    expect(p.source).toBe('phone')
  })

  it('rejects an empty hours list', () => rejects(body({ hours: [] }), 400, /hours must not be empty/))
  it('rejects a non-object body', () => rejects([1], 400, /JSON object/))
  it('rejects a bad source', () => rejects(body({ source: 'watch' }), 400, /source must be/))
  it('refuses source phone from the mac token', () => rejects(body({ source: 'phone' }), 403, /mac token/))
  it('refuses the shortcut role outright', () => rejects(body(), 403, /forbidden/, 'shortcut'))
  it('rejects a missing device', () => rejects(body({ device: '' }), 400, /device must not be empty/))
  it('rejects a missing window', () => rejects(body({ window: null }), 400, /window/))
  it('rejects an inverted window', () => rejects(body({ window: { from: TO, to: FROM } }), 400, /after window.from/))
  it('rejects a window over 48 h', () => rejects(body({ window: { from: '2026-09-26T12:59:59.000Z', to: TO } }), 400, /48 hours/))
  it('rejects hour_start off the hour', () =>
    rejects(body({ hours: [{ hour_start: '2026-09-28T13:30:00.000Z', app_id: 'a', seconds: 1 }] }), 400, /minute 0/))
  it('rejects hour_start outside the window', () => {
    rejects(body({ hours: [{ hour_start: '2026-09-28T12:00:00.000Z', app_id: 'a', seconds: 1 }] }), 400, /outside the window/)
    rejects(body({ hours: [{ hour_start: TO, app_id: 'a', seconds: 1 }] }), 400, /outside the window/)
  })
  it('rejects bad seconds', () => {
    rejects(body({ hours: [{ hour_start: FROM, app_id: 'a', seconds: 3601 }] }), 400, /between 0 and 3600/)
    rejects(body({ hours: [{ hour_start: FROM, app_id: 'a', seconds: -1 }] }), 400, /between 0 and 3600/)
    rejects(body({ hours: [{ hour_start: FROM, app_id: 'a', seconds: 1.5 }] }), 400, /between 0 and 3600/)
    rejects(body({ hours: [{ hour_start: FROM, app_id: 'a', seconds: '60' }] }), 400, /between 0 and 3600/)
  })
  it('rejects a missing app_id', () => rejects(body({ hours: [{ hour_start: FROM, seconds: 1 }] }), 400, /app_id must be a string/))
  it('rejects a malformed interval', () => {
    rejects(body({ intervals: [{ start: FROM, end: FROM, top_app: null }] }), 400, /end must be after start/)
    rejects(body({ intervals: [{ start: '2026-09-28T12:59:00.000Z', end: FROM, top_app: null }] }), 400, /outside the window/)
    rejects(body({ intervals: [{ start: FROM, end: TO, top_app: 7 }] }), 400, /top_app must be a string/)
    rejects(body({ intervals: 'x' }), 400, /intervals must be an array/)
  })
  it('rejects a malformed app entry', () => {
    rejects(body({ apps: [{ app_id: 'a', label: 3 }] }), 400, /label must be a string or null/)
    rejects(body({ apps: [{ label: 'x' }] }), 400, /app_id must be a string/)
  })
})

describe('daysTouched', () => {
  it('lists every local day the window touches', () => {
    expect(daysTouched(FROM, TO, TZ)).toEqual(['2026-09-28'])
    // 22:00 EDT on the 27th to 02:00 EDT on the 28th
    expect(daysTouched('2026-09-28T02:00:00.000Z', '2026-09-28T06:00:00.000Z', TZ)).toEqual(['2026-09-27', '2026-09-28'])
    // a window ending exactly at local midnight does not touch the next day
    expect(daysTouched('2026-09-28T02:00:00.000Z', '2026-09-28T04:00:00.000Z', TZ)).toEqual(['2026-09-27'])
    // 48 h can touch three local days
    expect(daysTouched('2026-09-27T00:00:00.000Z', '2026-09-29T00:00:00.000Z', TZ)).toEqual(['2026-09-26', '2026-09-27', '2026-09-28'])
  })
})

describe('appsSeen', () => {
  it('sums seconds per app, includes interval top apps and labelled apps, and skips _total', () => {
    const p = parseScreentimeBody(body({
      hours: [
        { hour_start: FROM, app_id: 'a', seconds: 10 },
        { hour_start: '2026-09-28T14:00:00.000Z', app_id: 'a', seconds: 20 },
        { hour_start: FROM, app_id: '_total', seconds: 30 },
      ],
      intervals: [{ start: FROM, end: TO, top_app: 'b' }],
      apps: [{ app_id: 'c', label: 'See' }, { app_id: 'a', label: 'Ay' }],
    }), 'mac')
    expect(appsSeen(p)).toEqual([
      { app_id: 'a', label: 'Ay', seconds: 30 },
      { app_id: 'b', label: null, seconds: 0 },
      { app_id: 'c', label: 'See', seconds: 0 },
    ])
  })
})

describe('planScreentime', () => {
  const now = new Date('2026-09-29T12:00:00.000Z')
  const plan = () => planScreentime(parseScreentimeBody(body(), 'mac'), now, TZ)

  it('looks up existing app ids first, then deletes the window before inserting', () => {
    const p = plan()
    expect(p.lookups).toHaveLength(1)
    expect(p.lookups[0]?.sql).toBe('SELECT app_id FROM app_categories WHERE app_id IN (?, ?)')
    expect(p.lookups[0]?.params).toEqual(['com.apple.Safari', 'com.microsoft.VSCode'])
    expect(p.writes[0]).toEqual({
      sql: 'DELETE FROM screen_hours WHERE source = ? AND device = ? AND hour_start >= ? AND hour_start < ?',
      params: ['mac', 'mbp', FROM, TO],
    })
    expect(p.writes[1]).toEqual({
      sql: 'DELETE FROM screen_intervals WHERE source = ? AND device = ? AND start_ts >= ? AND start_ts < ?',
      params: ['mac', 'mbp', FROM, TO],
    })
  })
  it('upserts hours, intervals and app_categories with the contract semantics', () => {
    const p = plan()
    const hours = p.writes[2]
    expect(hours?.sql).toContain('INSERT INTO screen_hours (source, device, hour_start, app_id, seconds, updated_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?) ON CONFLICT(source, device, hour_start, app_id) DO UPDATE SET seconds = excluded.seconds')
    expect(hours?.params.slice(0, 6)).toEqual(['mac', 'mbp', FROM, 'com.apple.Safari', 900, now.toISOString()])
    const ivs = p.writes[3]
    expect(ivs?.sql).toContain('INSERT INTO screen_intervals (source, device, start_ts, end_ts, top_app, updated_at) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?) ON CONFLICT(source, device, start_ts) DO UPDATE SET end_ts = excluded.end_ts, top_app = excluded.top_app')
    const apps = p.writes[4]
    expect(apps?.sql).toContain('INSERT INTO app_categories (app_id, label, seen_seconds, updated_at) VALUES (?, ?, ?, ?), (?, ?, ?, ?) ON CONFLICT(app_id) DO UPDATE SET seen_seconds = app_categories.seen_seconds + excluded.seen_seconds, label = COALESCE(app_categories.label, excluded.label)')
    expect(apps?.sql).not.toContain('category')
    expect(apps?.params).toEqual(['com.apple.Safari', 'Safari', 900, now.toISOString(), 'com.microsoft.VSCode', null, 5400, now.toISOString()])
  })
  it('records automation_health with the row counts and marks past days dirty', () => {
    const p = plan()
    expect(p.writes[5]).toEqual({ sql: HEALTH_SQL, params: ['mac', now.toISOString(), '3 hours / 2 intervals'] })
    expect(p.writes[6]).toEqual({ sql: DIRTY_SQL, params: ['2026-09-28', now.toISOString()] })
    expect(p.writes).toHaveLength(7)
    expect(p.days).toEqual(['2026-09-28'])
    expect(p.dirtyDays).toEqual(['2026-09-28'])
  })
  it('does not mark today dirty', () => {
    const p = planScreentime(parseScreentimeBody(body(), 'mac'), new Date('2026-09-28T16:00:00.000Z'), TZ)
    expect(p.dirtyDays).toEqual([])
    expect(p.days).toEqual(['2026-09-28'])
    expect(p.writes.some((w) => w.sql === DIRTY_SQL)).toBe(false)
  })
  it('keeps every statement under the D1 binding limit', () => {
    const hours = []
    for (let h = 0; h < 40; h++) {
      const hs = new Date(Date.UTC(2026, 8, 27, h)).toISOString()
      for (let a = 0; a < 30; a++) hours.push({ hour_start: hs, app_id: `com.app.${a}`, seconds: 60 })
    }
    const intervals = Array.from({ length: 200 }, (_, i) => ({
      start: new Date(Date.UTC(2026, 8, 27, 0, 0, i)).toISOString(), end: new Date(Date.UTC(2026, 8, 27, 0, 0, i + 1)).toISOString(), top_app: 'com.app.1',
    }))
    const p = planScreentime(parseScreentimeBody(body({ window: { from: '2026-09-27T00:00:00.000Z', to: '2026-09-28T16:00:00.000Z' }, hours, intervals }), 'mac'), now, TZ)
    for (const s of [...p.lookups, ...p.writes]) {
      expect(s.params.length, s.sql.slice(0, 40)).toBeLessThanOrEqual(MAX_BINDINGS)
      expect((s.sql.match(/\?/g) ?? []).length).toBe(s.params.length)
    }
    const inserted = p.writes.filter((w) => w.sql.startsWith('INSERT INTO screen_hours')).reduce((n, w) => n + w.params.length / 6, 0)
    expect(inserted).toBe(1200)
    expect(p.days).toEqual(['2026-09-26', '2026-09-27', '2026-09-28'])
  })
  it('phone totals never create an app_categories row', () => {
    const p = planScreentime(parseScreentimeBody(body({ source: 'phone', hours: [{ hour_start: FROM, app_id: '_total', seconds: 600 }], intervals: [], apps: [] }), 'app'), now, TZ)
    expect(p.lookups).toEqual([])
    expect(p.writes.some((w) => w.sql.startsWith('INSERT INTO app_categories'))).toBe(false)
    expect(p.writes.find((w) => w.sql === HEALTH_SQL)?.params).toEqual(['phone', now.toISOString(), '1 hours / 0 intervals'])
  })
})
