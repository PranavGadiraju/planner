import { describe, expect, it } from 'vitest'
import { HttpError } from '../src/worker/http'
import {
  BLOCK_CATEGORIES, daysBetween, groupWeek, matchProject, parseBlocksBody, parseDay, parseRange, parseSessionBody, parseWhen, resolveSpan,
} from '../src/worker/routes/work/parse'

const TZ = 'America/New_York'
const DAY = '2026-09-28' // a Monday, EDT (-04:00)
const NOW = new Date('2026-09-28T18:30:00.000Z') // 14:30 local

const status = (fn: () => unknown): number => {
  try {
    fn()
  } catch (e) {
    if (e instanceof HttpError) return e.status
    throw e
  }
  return 0
}
const message = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return ''
}

describe('parseWhen', () => {
  it("places a local 'HH:MM' on the day in tz and flags it as wall-clock", () => {
    expect(parseWhen('09:05', DAY, TZ, 'start')).toEqual({ at: new Date('2026-09-28T13:05:00.000Z'), wall: true })
    expect(parseWhen('9:05', DAY, TZ, 'start').at.toISOString()).toBe('2026-09-28T13:05:00.000Z')
    expect(parseWhen('23:30', DAY, TZ, 'start').at.toISOString()).toBe('2026-09-29T03:30:00.000Z')
    // the same wall clock in winter is EST
    expect(parseWhen('09:05', '2026-01-15', TZ, 'start').at.toISOString()).toBe('2026-01-15T14:05:00.000Z')
  })
  it('passes ISO instants through untouched', () => {
    const r = parseWhen('2026-09-28T13:05:00.000Z', DAY, TZ, 'start')
    expect(r.wall).toBe(false)
    expect(r.at.toISOString()).toBe('2026-09-28T13:05:00.000Z')
    expect(parseWhen('2026-09-28T09:05:00-04:00', DAY, TZ, 'start').at.toISOString()).toBe('2026-09-28T13:05:00.000Z')
  })
  it('rejects garbage with a 400 naming the field', () => {
    expect(status(() => parseWhen('25:00', DAY, TZ, 'start'))).toBe(400)
    expect(status(() => parseWhen('09:60', DAY, TZ, 'start'))).toBe(400)
    expect(status(() => parseWhen('noon', DAY, TZ, 'end'))).toBe(400)
    expect(message(() => parseWhen('noon', DAY, TZ, 'end'))).toContain('end')
    expect(status(() => parseWhen(915, DAY, TZ, 'start'))).toBe(400)
    expect(status(() => parseWhen('', DAY, TZ, 'start'))).toBe(400)
  })
})

describe('parseDay / parseRange', () => {
  it("defaults to today in tz, accepts 'today' and real dates only", () => {
    expect(parseDay(undefined, NOW, TZ)).toBe(DAY)
    expect(parseDay('', NOW, TZ)).toBe(DAY)
    expect(parseDay('today', NOW, TZ)).toBe(DAY)
    expect(parseDay('2026-01-02', NOW, TZ)).toBe('2026-01-02')
    expect(parseDay('today', new Date('2026-09-29T03:30:00.000Z'), TZ)).toBe('2026-09-28') // 23:30 EDT is still the 28th
  })
  it('rejects malformed days', () => {
    expect(status(() => parseDay('2026-13-45', NOW, TZ))).toBe(400)
    expect(status(() => parseDay('yesterday', NOW, TZ))).toBe(400)
    expect(status(() => parseDay(20260928, NOW, TZ))).toBe(400)
  })
  it('ranges default to today, to defaults to from, and must be ordered and at most a year', () => {
    expect(parseRange(null, null, NOW, TZ)).toEqual({ from: DAY, to: DAY })
    expect(parseRange('2026-09-01', null, NOW, TZ)).toEqual({ from: '2026-09-01', to: '2026-09-01' })
    expect(parseRange('2026-09-01', '2026-09-28', NOW, TZ)).toEqual({ from: '2026-09-01', to: '2026-09-28' })
    expect(status(() => parseRange('2026-09-28', '2026-09-27', NOW, TZ))).toBe(400)
    expect(status(() => parseRange('2025-01-01', '2026-09-28', NOW, TZ))).toBe(400)
    expect(daysBetween('2026-09-01', '2026-09-28')).toBe(27)
  })
})

describe('resolveSpan', () => {
  it('minutes alone ends now on today and starts minutes earlier', () => {
    const s = resolveSpan({ minutes: 90 }, DAY, TZ, NOW)
    expect(s).toEqual({ started_at: '2026-09-28T17:00:00.000Z', ended_at: '2026-09-28T18:30:00.000Z', duration_s: 5400, local_day: DAY })
  })
  it('minutes alone on a past day ends at the same wall-clock time on that day', () => {
    const s = resolveSpan({ minutes: 60 }, '2026-09-25', TZ, NOW)
    expect(s.ended_at).toBe('2026-09-25T18:30:00.000Z') // 14:30 EDT on the 25th
    expect(s.started_at).toBe('2026-09-25T17:30:00.000Z')
    expect(s.local_day).toBe('2026-09-25')
  })
  it('minutes alone never starts before local midnight of the day (the span shifts forward)', () => {
    const early = new Date('2026-09-28T04:30:00.000Z') // 00:30 local
    const s = resolveSpan({ minutes: 90 }, DAY, TZ, early)
    expect(s.started_at).toBe('2026-09-28T04:00:00.000Z') // local midnight
    expect(s.ended_at).toBe('2026-09-28T05:30:00.000Z')
    expect(s.local_day).toBe(DAY)
  })
  it("start+end as 'HH:MM' on the day, wrapping past midnight when end <= start", () => {
    const s = resolveSpan({ start: '09:00', end: '10:30' }, DAY, TZ, NOW)
    expect(s).toEqual({ started_at: '2026-09-28T13:00:00.000Z', ended_at: '2026-09-28T14:30:00.000Z', duration_s: 5400, local_day: DAY })
    const late = resolveSpan({ start: '23:30', end: '00:15' }, DAY, TZ, NOW)
    expect(late.started_at).toBe('2026-09-29T03:30:00.000Z')
    expect(late.ended_at).toBe('2026-09-29T04:15:00.000Z')
    expect(late.duration_s).toBe(45 * 60)
    expect(late.local_day).toBe(DAY) // the day of started_at
  })
  it('start+minutes and end+minutes, ISO or local', () => {
    expect(resolveSpan({ start: '2026-09-28T13:00:00.000Z', minutes: 25 }, DAY, TZ, NOW)).toMatchObject({ ended_at: '2026-09-28T13:25:00.000Z', duration_s: 1500 })
    expect(resolveSpan({ end: '10:00', minutes: 50 }, DAY, TZ, NOW)).toMatchObject({ started_at: '2026-09-28T13:10:00.000Z', duration_s: 3000 })
    // a local start on a day gives that day, even when the instant is on another UTC date
    expect(resolveSpan({ start: '22:00', minutes: 30 }, DAY, TZ, NOW).local_day).toBe(DAY)
  })
  it('rejects contradictory, incomplete or absurd input', () => {
    expect(status(() => resolveSpan({}, DAY, TZ, NOW))).toBe(400)
    expect(status(() => resolveSpan({ start: '09:00' }, DAY, TZ, NOW))).toBe(400)
    expect(status(() => resolveSpan({ end: '09:00' }, DAY, TZ, NOW))).toBe(400)
    expect(status(() => resolveSpan({ start: '09:00', end: '10:00', minutes: 30 }, DAY, TZ, NOW))).toBe(400)
    expect(status(() => resolveSpan({ start: '2026-09-28T10:00:00Z', end: '2026-09-28T09:00:00Z' }, DAY, TZ, NOW))).toBe(400) // ISO does not wrap
    expect(status(() => resolveSpan({ minutes: 0 }, DAY, TZ, NOW))).toBe(400)
    expect(status(() => resolveSpan({ minutes: -5 }, DAY, TZ, NOW))).toBe(400)
    expect(status(() => resolveSpan({ minutes: 1441 }, DAY, TZ, NOW))).toBe(400)
    expect(status(() => resolveSpan({ minutes: 'lots' }, DAY, TZ, NOW))).toBe(400)
    expect(status(() => resolveSpan({ start: '2026-09-27T00:00:00Z', end: '2026-09-28T12:00:00Z' }, DAY, TZ, NOW))).toBe(400) // > 24 h
  })
  it('accepts numeric strings for minutes (query-string style)', () => {
    expect(resolveSpan({ minutes: '45' }, DAY, TZ, NOW).duration_s).toBe(2700)
  })
})

describe('parseSessionBody', () => {
  it('needs a project and a span; note and day are optional', () => {
    const b = parseSessionBody({ project: ' planner ', minutes: 90, note: '  wrote the sync layer ' }, NOW, TZ)
    expect(b.project).toBe('planner')
    expect(b.day).toBe(DAY)
    expect(b.note).toBe('wrote the sync layer')
    expect(b.span.duration_s).toBe(5400)
    expect(parseSessionBody({ project: 'p', start: '09:00', end: '09:30', day: '2026-09-25' }, NOW, TZ).span.local_day).toBe('2026-09-25')
    expect(parseSessionBody({ project: 'p', minutes: 5, note: '' }, NOW, TZ).note).toBeNull()
  })
  it('rejects bad bodies with 400', () => {
    expect(status(() => parseSessionBody(null, NOW, TZ))).toBe(400)
    expect(status(() => parseSessionBody([], NOW, TZ))).toBe(400)
    expect(status(() => parseSessionBody({ minutes: 10 }, NOW, TZ))).toBe(400)
    expect(status(() => parseSessionBody({ project: '', minutes: 10 }, NOW, TZ))).toBe(400)
    expect(status(() => parseSessionBody({ project: 'p' }, NOW, TZ))).toBe(400)
    expect(status(() => parseSessionBody({ project: 'p', minutes: 10, note: 42 }, NOW, TZ))).toBe(400)
    expect(status(() => parseSessionBody({ project: 'p', minutes: 10, note: 'x'.repeat(2001) }, NOW, TZ))).toBe(400)
    expect(status(() => parseSessionBody({ project: 'p', minutes: 10, day: '2026-02-30' }, NOW, TZ))).toBe(400)
  })
})

describe('parseBlocksBody', () => {
  it("parses local 'HH:MM' blocks on the day, validating the category and wrapping past midnight", () => {
    const { day, blocks } = parseBlocksBody(
      { blocks: [{ start: '12:00', end: '12:40', category: 'meal', label: ' Lunch ' }, { start: '23:00', end: '00:30', category: 'study', project: 'planner' }] },
      NOW,
      TZ,
    )
    expect(day).toBe(DAY)
    expect(blocks[0]).toEqual({ start_ts: '2026-09-28T16:00:00.000Z', end_ts: '2026-09-28T16:40:00.000Z', category: 'meal', label: 'Lunch', project: null })
    expect(blocks[1]).toEqual({ start_ts: '2026-09-29T03:00:00.000Z', end_ts: '2026-09-29T04:30:00.000Z', category: 'study', label: null, project: 'planner' })
  })
  it('accepts ISO instants and an explicit day', () => {
    const { blocks } = parseBlocksBody({ day: '2026-09-25', blocks: [{ start: '2026-09-25T13:00:00Z', end: '14:00', category: 'other' }] }, NOW, TZ)
    expect(blocks[0]).toMatchObject({ start_ts: '2026-09-25T13:00:00.000Z', end_ts: '2026-09-25T18:00:00.000Z' })
  })
  it('rejects bad shapes and categories outside the schema list', () => {
    expect(status(() => parseBlocksBody({}, NOW, TZ))).toBe(400)
    expect(status(() => parseBlocksBody({ blocks: [] }, NOW, TZ))).toBe(400)
    expect(status(() => parseBlocksBody({ blocks: [1] }, NOW, TZ))).toBe(400)
    expect(status(() => parseBlocksBody({ blocks: [{ start: '09:00', end: '10:00', category: 'gaming' }] }, NOW, TZ))).toBe(400)
    expect(message(() => parseBlocksBody({ blocks: [{ start: '09:00', end: '10:00', category: 'gaming' }] }, NOW, TZ))).toContain('blocks[0].category')
    expect(status(() => parseBlocksBody({ blocks: [{ start: '2026-09-28T10:00:00Z', end: '2026-09-28T09:00:00Z', category: 'rest' }] }, NOW, TZ))).toBe(400)
    expect(status(() => parseBlocksBody({ blocks: [{ start: '09:00', end: '10:00', category: 'rest', project: 7 }] }, NOW, TZ))).toBe(400)
    expect(status(() => parseBlocksBody({ blocks: Array.from({ length: 201 }, () => ({ start: '09:00', end: '10:00', category: 'rest' })) }, NOW, TZ))).toBe(400)
    expect(BLOCK_CATEGORIES).toHaveLength(11)
  })
})

describe('matchProject', () => {
  const list = [
    { id: 'p1', name: 'Planner', archived_at: null, position: 2 },
    { id: 'p2', name: 'planner', archived_at: '2026-01-01T00:00:00.000Z', position: 1 },
    { id: 'p3', name: 'Thesis', archived_at: null, position: 3 },
  ]
  it('matches by id first, then case-insensitively by name preferring active projects', () => {
    expect(matchProject(list, 'p3')?.id).toBe('p3')
    expect(matchProject(list, 'PLANNER')?.id).toBe('p1')
    expect(matchProject(list, '  thesis ')?.id).toBe('p3')
    expect(matchProject(list, 'nope')).toBeNull()
  })
})

describe('groupWeek', () => {
  it('lays rows onto the seven days from the week start and ignores the rest', () => {
    const rows = [
      { local_day: '2026-09-28', project_id: 'a', seconds: 3600 },
      { local_day: '2026-09-28', project_id: 'b', seconds: 600 },
      { local_day: '2026-09-30', project_id: 'a', seconds: 1800 },
      { local_day: '2026-10-05', project_id: 'a', seconds: 99 }, // next week
      { local_day: '2026-09-27', project_id: 'a', seconds: 99 }, // last week
    ]
    const days = groupWeek(rows, '2026-09-28')
    expect(days.map((d) => d.local_day)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'])
    expect(days[0]).toEqual({ local_day: '2026-09-28', seconds: 4200, by_project: { a: 3600, b: 600 } })
    expect(days[2]?.by_project).toEqual({ a: 1800 })
    expect(days.reduce((a, d) => a + d.seconds, 0)).toBe(6000)
    expect(groupWeek(rows, '2026-09-21')[6]).toEqual({ local_day: '2026-09-27', seconds: 99, by_project: { a: 99 } })
  })
  it('treats null sums as zero', () => {
    expect(groupWeek([{ local_day: '2026-09-28', project_id: 'a', seconds: null }], '2026-09-28')[0]?.seconds).toBe(0)
  })
})
