import { describe, expect, it } from 'vitest'
import type { AppCategoryRow, HealthRow } from '@shared/types'
import {
  CATEGORIES, categoryRow, displayName, filterApps, macLastSeen, macStatus, phoneStatus, seenLabel, splitApps,
} from '../src/app/data/apps'

const TZ = 'America/New_York'
const row = (app_id: string, over: Partial<AppCategoryRow> = {}): AppCategoryRow => ({
  app_id, label: null, category: null, seen_seconds: 0, updated_at: '2026-09-28T12:00:00.000Z', deleted_at: null, ...over,
})

describe('displayName / seenLabel', () => {
  it('prefers the label, else the last bundle segment', () => {
    expect(displayName(row('com.apple.Safari', { label: 'Safari' }))).toBe('Safari')
    expect(displayName(row('com.apple.Safari', { label: '  ' }))).toBe('Safari')
    expect(displayName(row('com.todesktop.230313mzl4w4u92'))).toBe('230313mzl4w4u92')
    expect(displayName(row('dev.warp.Warp-Stable'))).toBe('Warp Stable')
  })
  it('formats seen seconds', () => {
    expect(seenLabel(0)).toBe('not seen')
    expect(seenLabel(59)).toBe('< 1 min')
    expect(seenLabel(90)).toBe('2 min')
    expect(seenLabel(35 * 60)).toBe('35 min')
    expect(seenLabel(3600)).toBe('1 h')
    expect(seenLabel(80 * 60)).toBe('1 h 20')
    expect(seenLabel(12 * 3600 + 600)).toBe('12 h')
  })
})

describe('filterApps', () => {
  const rows = [row('com.apple.Safari', { label: 'Safari', category: 'browsing' }), row('com.microsoft.VSCode', { label: 'Visual Studio Code' }), row('md.obsidian')]
  it('returns everything for a blank query', () => {
    expect(filterApps(rows, '  ')).toHaveLength(3)
  })
  it('matches label, bundle id and category, ignoring case', () => {
    expect(filterApps(rows, 'safari').map((r) => r.app_id)).toEqual(['com.apple.Safari'])
    expect(filterApps(rows, 'VSCODE').map((r) => r.app_id)).toEqual(['com.microsoft.VSCode'])
    expect(filterApps(rows, 'obsid').map((r) => r.app_id)).toEqual(['md.obsidian'])
    expect(filterApps(rows, 'brows').map((r) => r.app_id)).toEqual(['com.apple.Safari'])
    expect(filterApps(rows, 'zzz')).toEqual([])
  })
})

describe('splitApps', () => {
  it('puts NULL categories in the triage list, most seen first, and groups the rest in CATEGORIES order', () => {
    const rows = [
      row('a', { seen_seconds: 10 }),
      row('b', { seen_seconds: 500 }),
      row('c', { category: 'media', seen_seconds: 5 }),
      row('d', { category: 'dev', seen_seconds: 50 }),
      row('e', { category: 'dev', seen_seconds: 80 }),
      row('gone', { deleted_at: '2026-09-28T12:00:00.000Z' }),
    ]
    const { triage, groups } = splitApps(rows)
    expect(triage.map((r) => r.app_id)).toEqual(['b', 'a'])
    expect(groups.map((g) => g.category)).toEqual(['dev', 'media'])
    expect(groups[0]?.rows.map((r) => r.app_id)).toEqual(['e', 'd'])
    expect(groups[0]?.seconds).toBe(130)
    expect(CATEGORIES).toEqual(['dev', 'work', 'comms', 'browsing', 'media', 'social', 'other'])
  })
  it('handles an empty list', () => {
    expect(splitApps([])).toEqual({ triage: [], groups: [] })
  })
})

describe('categoryRow', () => {
  it('writes category and label only, never seen_seconds, with a fresh updated_at and no tombstone', () => {
    const at = new Date('2026-09-28T15:00:00.000Z')
    expect(categoryRow(row('com.apple.Safari', { label: 'Safari', seen_seconds: 999 }), 'browsing', at)).toEqual({
      app_id: 'com.apple.Safari', label: 'Safari', category: 'browsing', updated_at: '2026-09-28T15:00:00.000Z', deleted_at: null,
    })
  })
})

describe('health strip', () => {
  const macRow = (last_ok_at: string | null): HealthRow => ({ source: 'mac', last_ok_at, last_error_at: null, last_error: null, detail: null })
  const noon = new Date('2026-09-28T16:00:00.000Z') // 12:00 EDT
  const night = new Date('2026-09-29T04:00:00.000Z') // 00:00 EDT

  it('picks the newer of the health row and the last pushed hour', () => {
    expect(macLastSeen({ rows: [], mac_last_hour: null })).toBeNull()
    expect(macLastSeen({ rows: [macRow('2026-09-28T15:05:00.000Z')], mac_last_hour: '2026-09-28T15:00:00.000Z' })).toBe('2026-09-28T15:05:00.000Z')
    expect(macLastSeen({ rows: [macRow('2026-09-28T13:05:00.000Z')], mac_last_hour: '2026-09-28T15:00:00.000Z' })).toBe('2026-09-28T15:00:00.000Z')
    expect(macLastSeen({ rows: [macRow(null)], mac_last_hour: '2026-09-28T15:00:00.000Z' })).toBe('2026-09-28T15:00:00.000Z')
    expect(macLastSeen({ rows: [macRow('2026-09-28T15:05:00.000Z')], mac_last_hour: null })).toBe('2026-09-28T15:05:00.000Z')
  })
  it('says no data yet without any push', () => {
    expect(macStatus({ rows: [], mac_last_hour: null }, noon, TZ)).toEqual({ text: 'Mac: no data yet', warn: false })
  })
  it('flags a push older than 3 h during the day only', () => {
    const fresh = { rows: [macRow('2026-09-28T15:05:00.000Z')], mac_last_hour: null }
    expect(macStatus(fresh, noon, TZ)).toEqual({ text: 'Mac: last push 55 min ago', warn: false })
    const old = { rows: [macRow('2026-09-28T11:00:00.000Z')], mac_last_hour: null }
    expect(macStatus(old, noon, TZ)).toEqual({ text: 'Mac: last push 5 h ago', warn: true })
    const exactly3h = { rows: [macRow('2026-09-28T13:00:00.000Z')], mac_last_hour: null }
    expect(macStatus(exactly3h, noon, TZ).warn).toBe(false)
    const atNight = { rows: [macRow('2026-09-28T20:00:00.000Z')], mac_last_hour: null }
    expect(macStatus(atNight, night, TZ)).toEqual({ text: 'Mac: last push 8 h ago', warn: false })
    // 08:00 local is inside the watch window, 07:59 is not
    const eight = new Date('2026-09-28T12:00:00.000Z')
    const sevenFiftyNine = new Date('2026-09-28T11:59:00.000Z')
    const stale = { rows: [macRow('2026-09-28T05:00:00.000Z')], mac_last_hour: null }
    expect(macStatus(stale, eight, TZ).warn).toBe(true)
    expect(macStatus(stale, sevenFiftyNine, TZ).warn).toBe(false)
  })
  it('nudges for a screenshot when the phone has no rows today', () => {
    expect(phoneStatus({ phone_last_hour: null }, noon, TZ)).toEqual({ text: 'Phone: none today · paste a Screen Time screenshot into Claude Code', warn: false })
    expect(phoneStatus({ phone_last_hour: '2026-09-27T20:00:00.000Z' }, noon, TZ).text).toMatch(/none today/)
    expect(phoneStatus({ phone_last_hour: '2026-09-28T14:00:00.000Z' }, noon, TZ)).toEqual({ text: 'Phone: today through 10:00', warn: false })
  })
})
