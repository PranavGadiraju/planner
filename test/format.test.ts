import { describe, expect, it } from 'vitest'
import { agoLabel, dayLabel, durationLabel, elapsedLabel, lateLabel, minusMinutes, shortName } from '../src/app/data/format'

describe('format helpers', () => {
  it('labels a local day with weekday and month', () => {
    expect(dayLabel('2026-09-28')).toBe('Mon 28 Sep')
    expect(dayLabel('2026-01-04')).toBe('Sun 4 Jan')
  })
  it('formats durations and elapsed time', () => {
    expect(durationLabel(41)).toBe('41 min')
    expect(durationLabel(452)).toBe('7h32')
    expect(durationLabel(120)).toBe('2h00')
    const start = '2026-09-28T10:00:00.000Z'
    expect(elapsedLabel(start, new Date('2026-09-28T10:12:30.000Z'))).toBe('12m')
    expect(elapsedLabel(start, new Date('2026-09-28T11:05:00.000Z'))).toBe('1h05')
  })
  it('formats late minutes and relative ages', () => {
    expect(lateLabel(20)).toBe('+20 min')
    expect(lateLabel(-5)).toBe('−5 min')
    expect(lateLabel(0)).toBe('on time')
    const now = new Date('2026-09-28T12:00:00.000Z')
    expect(agoLabel(null, now)).toBe('never')
    expect(agoLabel('2026-09-28T11:59:30.000Z', now)).toBe('just now')
    expect(agoLabel('2026-09-28T11:48:00.000Z', now)).toBe('12 min ago')
    expect(agoLabel('2026-09-28T08:00:00.000Z', now)).toBe('4 h ago')
    expect(agoLabel('2026-09-25T12:00:00.000Z', now)).toBe('3 d ago')
  })
  it('shortens routine names to fit under a circle', () => {
    expect(shortName({ id: 'shower', name: 'Shower' })).toBe('Shower')
    expect(shortName({ id: 'run', name: 'Morning run' })).toBe('Run')
    expect(shortName({ id: 'shoulders', name: 'Shoulder routine' })).toBe('Shoulders')
    expect(shortName({ id: 'cold-plunge', name: 'Cold plunge in the tub' })).toBe('Cold plunge')
  })
  it('subtracts minutes from a wall-clock time, wrapping at midnight', () => {
    expect(minusMinutes('23:00', 45)).toBe('22:15')
    expect(minusMinutes('00:30', 45)).toBe('23:45')
  })
})
