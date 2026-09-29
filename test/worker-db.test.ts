import { describe, expect, it } from 'vitest'
import { buildUpsertSql, isTimestampColumn, parseSettings, rowLocalDay, TABLES, TABLE_NAMES, upsertFor, validateRow } from '../src/worker/db'
import { DEFAULT_SETTINGS } from '@shared/types'

const TZ = 'America/New_York'

describe('table registry', () => {
  it('lists exactly the tables /api/write may touch', () => {
    expect([...TABLE_NAMES].sort()).toEqual([
      'app_categories', 'checkins', 'exercises', 'food_log', 'foods', 'meal_items', 'meals', 'projects', 'routine_items',
      'routine_log', 'sessions', 'sets', 'settings', 'sleep', 'time_blocks', 'workouts',
    ])
  })
  it('every table has updated_at and its primary key inside the column allowlist', () => {
    for (const [name, spec] of Object.entries(TABLES)) {
      expect(spec.columns, name).toContain('updated_at')
      for (const pk of spec.pk) expect(spec.columns, `${name}.${pk}`).toContain(pk)
      expect(new Set(spec.columns).size, `${name} duplicate column`).toBe(spec.columns.length)
      if (spec.day) expect(spec.columns, `${name} day column`).toContain(spec.day.column)
    }
  })
  it('never lets server-only tables through', () => {
    for (const t of ['screen_hours', 'screen_intervals', 'day_summary', 'dirty_days', 'tap_log', 'automation_health']) {
      expect(TABLES[t]).toBeUndefined()
      expect(validateRow(t, { id: 1, updated_at: 'x' })).toMatchObject({ ok: false, reason: `unknown table ${t}` })
    }
  })
})

describe('buildUpsertSql', () => {
  it('upserts on the primary key with the updated_at guard', () => {
    expect(buildUpsertSql('routine_log', ['local_day', 'item_id', 'started_at', 'updated_at'])).toBe(
      'INSERT INTO routine_log (local_day, item_id, started_at, updated_at) VALUES (?, ?, ?, ?) ' +
        'ON CONFLICT(local_day, item_id) DO UPDATE SET started_at = excluded.started_at, updated_at = excluded.updated_at ' +
        'WHERE excluded.updated_at > routine_log.updated_at',
    )
  })
  it('settings rows are guarded too', () => {
    expect(buildUpsertSql('settings', ['key', 'value', 'updated_at'])).toContain('WHERE excluded.updated_at > settings.updated_at')
  })
  it('server-authoritative writes drop the guard', () => {
    const sql = buildUpsertSql('sleep', ['night_of', 'bed_ts', 'updated_at'], false)
    expect(sql).toBe('INSERT INTO sleep (night_of, bed_ts, updated_at) VALUES (?, ?, ?) ON CONFLICT(night_of) DO UPDATE SET bed_ts = excluded.bed_ts, updated_at = excluded.updated_at')
  })
  it('a pk-only row does nothing on conflict', () => {
    expect(buildUpsertSql('foods', ['id'])).toBe('INSERT INTO foods (id) VALUES (?) ON CONFLICT(id) DO NOTHING')
  })
  it('throws for an unknown table', () => {
    expect(() => buildUpsertSql('tap_log', ['id'])).toThrow('unknown table tap_log')
  })
})

describe('validateRow', () => {
  const now = '2026-09-28T12:00:00.000Z'
  it('accepts allowed columns, keeps their order and maps booleans to 0/1', () => {
    const r = validateRow('sets', { id: 's1', workout_id: 'w', exercise_id: 'e', set_no: 1, reps: 8, weight: 135, is_warmup: true, ts: now, updated_at: now, deleted_at: null })
    expect(r).toMatchObject({ ok: true, key: 's1' })
    if (!r.ok) throw new Error('unreachable')
    expect(r.columns).toEqual(['id', 'workout_id', 'exercise_id', 'set_no', 'reps', 'weight', 'is_warmup', 'ts', 'updated_at', 'deleted_at'])
    expect(r.params).toEqual(['s1', 'w', 'e', 1, 8, 135, 1, now, now, null])
  })
  it('composite keys join with |', () => {
    expect(validateRow('routine_log', { local_day: '2026-09-28', item_id: 'run', started_at: now, source: 'nfc', updated_at: now })).toMatchObject({ ok: true, key: '2026-09-28|run' })
  })
  it('rejects unknown columns, missing keys, missing updated_at and non-scalar values', () => {
    expect(validateRow('foods', { id: 'f', nope: 1, updated_at: now })).toMatchObject({ ok: false, key: 'f', reason: 'unknown column nope' })
    expect(validateRow('foods', { name: 'x', updated_at: now })).toMatchObject({ ok: false, reason: 'missing primary key id' })
    expect(validateRow('routine_log', { local_day: '2026-09-28', updated_at: now })).toMatchObject({ ok: false, reason: 'missing primary key item_id' })
    expect(validateRow('foods', { id: 'f', name: 'x' })).toMatchObject({ ok: false, reason: 'missing updated_at' })
    expect(validateRow('foods', { id: 'f', label_json: { a: 1 }, updated_at: now })).toMatchObject({ ok: false, reason: expect.stringContaining('label_json') })
    expect(validateRow('foods', { id: 'f', kcal_100: NaN, updated_at: now })).toMatchObject({ ok: false, reason: expect.stringContaining('kcal_100') })
  })
  it('skips undefined values instead of rejecting them', () => {
    const r = validateRow('settings', { key: 'tz', value: '"UTC"', updated_at: now, extra: undefined })
    expect(r.ok && r.columns).toEqual(['key', 'value', 'updated_at'])
  })
  it('day-scoped tables must carry their day column so dirty_days can always be marked', () => {
    // timestamp-derived day columns
    expect(validateRow('time_blocks', { id: 'b1', end_ts: now, category: 'rest', updated_at: now })).toMatchObject({ ok: false, key: 'b1', reason: 'missing start_ts' })
    expect(validateRow('time_blocks', { id: 'b1', start_ts: null, updated_at: now, deleted_at: now })).toMatchObject({ ok: false, reason: 'missing start_ts' })
    expect(validateRow('sleep', { night_of: '2026-09-28', wake_ts: now, updated_at: now })).toMatchObject({ ok: false, reason: 'missing bed_ts' })
    expect(validateRow('sets', { id: 's1', workout_id: 'w', exercise_id: 'e', set_no: 1, reps: 5, updated_at: now })).toMatchObject({ ok: false, reason: 'missing ts' })
    // local_day columns that are not part of the primary key
    expect(validateRow('food_log', { id: 'l1', ts: now, slot: 'lunch', label: 'x', kcal: 1, updated_at: now })).toMatchObject({ ok: false, reason: 'missing local_day' })
    expect(validateRow('workouts', { id: 'w1', started_at: now, updated_at: now })).toMatchObject({ ok: false, reason: 'missing local_day' })
    expect(validateRow('sessions', { id: 'x1', project_id: 'p', started_at: now, updated_at: now })).toMatchObject({ ok: false, reason: 'missing local_day' })
    // a tombstone still needs it
    expect(validateRow('time_blocks', { id: 'b1', updated_at: now, deleted_at: now })).toMatchObject({ ok: false, reason: 'missing start_ts' })
    expect(validateRow('time_blocks', { id: 'b1', start_ts: now, updated_at: now, deleted_at: now })).toMatchObject({ ok: true })
    // and it has to be usable
    expect(validateRow('time_blocks', { id: 'b1', start_ts: 'yesterday-ish', updated_at: now })).toMatchObject({ ok: false, reason: 'invalid start_ts' })
    expect(validateRow('food_log', { id: 'l1', local_day: '28/09/2026', updated_at: now })).toMatchObject({ ok: false, reason: 'invalid local_day' })
    // complete rows pass, and non-day tables are unaffected
    expect(validateRow('food_log', { id: 'l1', ts: now, local_day: '2026-09-28', slot: 'lunch', label: 'x', kcal: 1, updated_at: now })).toMatchObject({ ok: true })
    expect(validateRow('sleep', { night_of: '2026-09-28', bed_ts: now, updated_at: now })).toMatchObject({ ok: true })
    expect(validateRow('foods', { id: 'f', name: 'x', updated_at: now })).toMatchObject({ ok: true })
  })
  it('every day-scoped table rejects a row without its day column', () => {
    for (const [name, spec] of Object.entries(TABLES)) {
      if (!spec.day) continue
      const row: Record<string, unknown> = { updated_at: now }
      for (const pk of spec.pk) if (pk !== spec.day.column) row[pk] = 'k'
      const r = validateRow(name, row)
      expect(r.ok, name).toBe(false)
      if (r.ok) throw new Error('unreachable')
      // when the day column is the primary key itself the pk check speaks first
      expect(r.reason, name).toMatch(spec.pk.includes(spec.day.column) ? `missing primary key ${spec.day.column}` : `missing ${spec.day.column}`)
    }
  })
  it('every *_at / *_ts column must be a zoned ISO-8601 instant on a real day, every day column a real calendar day', () => {
    const set = { id: 's1', workout_id: 'w', exercise_id: 'e', set_no: 1, reps: 5, weight: 0, is_warmup: 0, updated_at: now }
    const bad = (table: string, row: object, reason: string) => expect(validateRow(table, row), JSON.stringify(row)).toMatchObject({ ok: false, reason })
    // what the app writes (Date#toISOString) and the other zoned forms pass
    expect(validateRow('foods', { id: 'f', name: 'x', created_at: new Date().toISOString(), updated_at: now, last_used_at: null, deleted_at: null })).toMatchObject({ ok: true })
    expect(validateRow('sets', { ...set, ts: '2026-09-28T06:00-04:00', updated_at: '2026-09-28T10:00:00Z' })).toMatchObject({ ok: true })
    expect(validateRow('checkins', { local_day: '2026-09-28', morning_at: '2026-09-28T11:05:00.123+02:00', morning_note: 'hi', updated_at: now })).toMatchObject({ ok: true })
    // the probes from the audit: a nonsense day, junk updated_at (would out-sort every real one), V8's legacy '12'
    bad('checkins', { local_day: '2025-13-45', updated_at: 'zzz' }, 'invalid local_day')
    bad('checkins', { local_day: '2026-09-28', updated_at: 'zzz' }, 'invalid updated_at')
    bad('sets', { ...set, ts: '12' }, 'invalid ts')
    bad('sets', { ...set, ts: '2026-09-28T10:00' }, 'invalid ts') // zone-less
    bad('sets', { ...set, ts: '2026-02-30T10:00:00Z' }, 'invalid ts') // not a real day
    bad('sets', { ...set, ts: '2026-09-28T24:00:00Z' }, 'invalid ts') // rolls over
    bad('sets', { ...set, ts: 1700000000000 }, 'invalid ts') // epoch numbers are not timestamps here
    bad('sleep', { night_of: '2026-02-30', bed_ts: now, updated_at: now }, 'invalid night_of')
    bad('sleep', { night_of: '2026-09-28', bed_ts: now, wake_ts: 'Sep 29 2026 07:00', updated_at: now }, 'invalid wake_ts')
    bad('routine_log', { local_day: '2026-09-28', item_id: 'run', started_at: 'garbage', updated_at: now }, 'invalid started_at')
    bad('routine_log', { local_day: '2026-09-28', item_id: 'run', started_at: now, ended_at: 0, updated_at: now }, 'invalid ended_at')
    bad('workouts', { id: 'w', local_day: '2026-09-28', started_at: now, ended_at: '2026-09-28', updated_at: now }, 'invalid ended_at')
    bad('sessions', { id: 'x', project_id: 'p', local_day: '2026-9-28', started_at: now, updated_at: now }, 'invalid local_day')
    bad('projects', { id: 'p', name: 'x', archived_at: 'soon', updated_at: now }, 'invalid archived_at')
    bad('exercises', { id: 'e', name: 'x', last_used_at: true, updated_at: now }, 'invalid last_used_at')
    bad('foods', { id: 'f', name: 'x', updated_at: now, deleted_at: 'yesterday' }, 'invalid deleted_at')
    bad('foods', { id: 'f', name: 'x', created_at: '', updated_at: now }, 'invalid created_at')
    bad('checkins', { local_day: '2026-09-28', evening_at: '2026-09-28T25:00:00Z', updated_at: now }, 'invalid evening_at')
    // null stays fine for nullable timestamps
    expect(validateRow('checkins', { local_day: '2026-09-28', morning_at: null, evening_at: null, updated_at: now })).toMatchObject({ ok: true })
  })
  it('isTimestampColumn covers exactly the registry\'s timestamp columns', () => {
    const cols = new Set<string>()
    for (const spec of Object.values(TABLES)) for (const c of spec.columns) if (isTimestampColumn(c)) cols.add(c)
    expect([...cols].sort()).toEqual([
      'archived_at', 'bed_ts', 'created_at', 'deleted_at', 'end_ts', 'ended_at', 'evening_at', 'last_used_at', 'morning_at',
      'start_ts', 'started_at', 'ts', 'updated_at', 'wake_ts',
    ])
    expect(isTimestampColumn('hour_start')).toBe(true)
    for (const c of ['fat_100', 'seen_seconds', 'total_g', 'label', 'local_day']) expect(isTimestampColumn(c), c).toBe(false)
  })
  it('upsertFor throws on a registry violation (server bug, not client data)', () => {
    expect(() => upsertFor('sleep', { night_of: '2026-09-28' })).toThrow('missing updated_at')
    expect(upsertFor('sleep', { night_of: '2026-09-28', bed_ts: now, updated_at: now }, false).params).toEqual(['2026-09-28', now, now])
  })
})

describe('rowLocalDay (dirty_days)', () => {
  it('uses local_day when the table has one', () => {
    expect(rowLocalDay('food_log', { local_day: '2026-09-20' }, TZ)).toBe('2026-09-20')
    expect(rowLocalDay('checkins', { local_day: 'garbage' }, TZ)).toBeNull()
  })
  it('converts timestamp columns to the local day in tz', () => {
    expect(rowLocalDay('time_blocks', { start_ts: '2026-09-29T03:30:00.000Z' }, TZ)).toBe('2026-09-28') // 23:30 EDT
    expect(rowLocalDay('sets', { ts: '2026-01-15T04:59:00.000Z' }, TZ)).toBe('2026-01-14') // 23:59 EST
    expect(rowLocalDay('sleep', { bed_ts: '2026-09-29T03:20:00.000Z' }, TZ)).toBe('2026-09-28')
    expect(rowLocalDay('sets', { ts: 'not a date' }, TZ)).toBeNull()
    expect(rowLocalDay('sets', { ts: '12' }, TZ)).toBeNull() // never 2001-12-01
    expect(rowLocalDay('checkins', { local_day: '2025-13-45' }, TZ)).toBeNull()
  })
  it('is null for tables that are not day-scoped', () => {
    expect(rowLocalDay('foods', { id: 'f', created_at: '2026-09-01T00:00:00Z' }, TZ)).toBeNull()
    expect(rowLocalDay('settings', { key: 'tz' }, TZ)).toBeNull()
  })
})

describe('parseSettings', () => {
  it('returns the defaults for an empty table', () => {
    expect(parseSettings([])).toEqual(DEFAULT_SETTINGS)
  })
  it('parses the seed rows', () => {
    const s = parseSettings([
      { key: 'tz', value: '"Europe/Paris"' }, { key: 'targets', value: '{"kcal":2000,"protein_g":150,"carb_g":200,"fat_g":70}' },
      { key: 'bed_target', value: '"22:30"' }, { key: 'winddown_min', value: '30' }, { key: 'late_grace_min', value: '10' }, { key: 'weight_unit', value: '"kg"' },
    ])
    expect(s).toEqual({ tz: 'Europe/Paris', targets: { kcal: 2000, protein_g: 150, carb_g: 200, fat_g: 70 }, bed_target: '22:30', winddown_min: 30, late_grace_min: 10, weight_unit: 'kg' })
  })
  it('falls back per key on malformed JSON, wrong types and unknown keys', () => {
    const s = parseSettings([
      { key: 'tz', value: 'not json' }, { key: 'targets', value: '{"kcal":"lots","protein_g":180}' }, { key: 'bed_target', value: '"11pm"' },
      { key: 'winddown_min', value: '"45"' }, { key: 'late_grace_min', value: '-3' }, { key: 'weight_unit', value: '"stone"' }, { key: 'mystery', value: '1' },
    ])
    expect(s).toEqual({ ...DEFAULT_SETTINGS, targets: { ...DEFAULT_SETTINGS.targets, protein_g: 180 } })
    expect(Object.keys(s)).not.toContain('mystery')
  })
})
