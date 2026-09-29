import { describe, expect, it } from 'vitest'
import { addDays, dayWindow, localDay, localHHMM, localMidnightUTC, weekStart, zonedToUTC } from '@shared/tz'

const TZ = 'America/New_York'

describe('tz', () => {
  it('localDay and localHHMM respect the zone', () => {
    expect(localDay('2026-09-29T03:30:00Z', TZ)).toBe('2026-09-28') // 23:30 EDT the day before
    expect(localHHMM('2026-09-29T03:30:00Z', TZ)).toBe('23:30')
    expect(localDay('2026-01-15T04:59:00Z', TZ)).toBe('2026-01-14') // 23:59 EST
    expect(localHHMM('2026-01-15T05:00:00Z', TZ)).toBe('00:00')
  })
  it('local midnight is 04:00Z in summer and 05:00Z in winter', () => {
    expect(localMidnightUTC('2026-07-04', TZ).toISOString()).toBe('2026-07-04T04:00:00.000Z')
    expect(localMidnightUTC('2026-01-15', TZ).toISOString()).toBe('2026-01-15T05:00:00.000Z')
  })
  it('day windows are 1440 min normally, 1380 on spring-forward and 1500 on fall-back', () => {
    expect(dayWindow('2026-06-10', TZ).minutes).toBe(1440)
    expect(dayWindow('2026-03-08', TZ).minutes).toBe(1380) // DST starts 2026-03-08 in the US
    expect(dayWindow('2026-11-01', TZ).minutes).toBe(1500) // DST ends 2026-11-01
  })
  it('zonedToUTC handles wall-clock times on either side of a DST change', () => {
    expect(zonedToUTC('2026-03-08', '01:30', TZ).toISOString()).toBe('2026-03-08T06:30:00.000Z') // EST
    expect(zonedToUTC('2026-03-08', '03:30', TZ).toISOString()).toBe('2026-03-08T07:30:00.000Z') // EDT
    expect(zonedToUTC('2026-11-01', '03:00', TZ).toISOString()).toBe('2026-11-01T08:00:00.000Z') // EST again
  })
  it('addDays and weekStart', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01')
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31')
    expect(weekStart('2026-09-28')).toBe('2026-09-28') // Monday
    expect(weekStart('2026-10-04')).toBe('2026-09-28') // Sunday belongs to the week starting Monday 28th
  })
})
