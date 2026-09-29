import { describe, expect, it } from 'vitest'
import { applyBedTap, applyWake, bedTargetInstant, bedtimeStreak, lateMinutes, nightOf } from '@shared/sleep'
import type { Sleep } from '@shared/types'

const TZ = 'America/New_York'
const S = { bed_target: '23:00' }
// helper: a local EDT wall-clock time on 2026-09-28/29 (UTC-4)
const local = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00-04:00`)

describe('nightOf / target', () => {
  it('23:30 and 01:00 belong to the same night', () => {
    expect(nightOf(local('2026-09-28', '23:30'), TZ)).toBe('2026-09-28')
    expect(nightOf(local('2026-09-29', '01:00'), TZ)).toBe('2026-09-28')
    expect(nightOf(local('2026-09-29', '13:00'), TZ)).toBe('2026-09-29')
  })
  it('target instant lands on the night date for evening targets and the next day for after-midnight targets', () => {
    expect(bedTargetInstant('2026-09-28', '23:00', TZ).toISOString()).toBe(local('2026-09-28', '23:00').toISOString())
    expect(bedTargetInstant('2026-09-28', '00:30', TZ).toISOString()).toBe(local('2026-09-29', '00:30').toISOString())
  })
  it('late minutes', () => {
    expect(lateMinutes(local('2026-09-28', '23:20'), '2026-09-28', '23:00', TZ)).toBe(20)
    expect(lateMinutes(local('2026-09-29', '00:20'), '2026-09-28', '23:00', TZ)).toBe(80)
    expect(lateMinutes(local('2026-09-28', '22:45'), '2026-09-28', '23:00', TZ)).toBe(-15)
  })
})

describe('bed tap state machine', () => {
  it('first evening tap creates the night with late_min', () => {
    const r = applyBedTap(null, local('2026-09-28', '23:20'), TZ, S, 'nfc')
    expect(r.action).toBe('bed')
    expect(r.row?.night_of).toBe('2026-09-28')
    expect(r.row?.late_min).toBe(20)
  })
  it('re-taps: <10 min duplicate, 10 min-3 h ignored, >=3 h wake', () => {
    const bed = applyBedTap(null, local('2026-09-28', '23:20'), TZ, S, 'nfc').row!
    expect(applyBedTap(bed, local('2026-09-28', '23:25'), TZ, S, 'nfc').action).toBe('bed_duplicate')
    expect(applyBedTap(bed, local('2026-09-29', '00:30'), TZ, S, 'nfc').action).toBe('bed_ignored')
    const wake = applyBedTap(bed, local('2026-09-29', '07:05'), TZ, S, 'nfc')
    expect(wake.action).toBe('wake')
    expect(wake.row?.wake_ts).toBe(local('2026-09-29', '07:05').toISOString())
    expect(applyBedTap(wake.row!, local('2026-09-29', '09:00'), TZ, S, 'nfc').action).toBe('wake_duplicate')
  })
  it('daytime tap with no open row is ignored', () => {
    expect(applyBedTap(null, local('2026-09-29', '14:00'), TZ, S, 'nfc').action).toBe('bed_daytime_ignored')
  })
  it('an early-evening sleep followed by a late tap becomes a nap plus a new bedtime', () => {
    const bed = applyBedTap(null, local('2026-09-28', '19:00'), TZ, S, 'nfc').row!
    const up = applyBedTap(bed, local('2026-09-28', '22:30'), TZ, S, 'nfc')
    expect(up.action).toBe('wake')
    const again = applyBedTap(up.row!, local('2026-09-28', '23:45'), TZ, S, 'nfc')
    expect(again.action).toBe('nap_then_bed')
    expect(again.nap).toEqual({ start: bed.bed_ts, end: up.row!.wake_ts })
    expect(again.row?.late_min).toBe(45)
    expect(again.row?.wake_ts).toBeNull()
  })
  it('applyWake closes an open row only after 3 h', () => {
    const bed = applyBedTap(null, local('2026-09-28', '23:20'), TZ, S, 'nfc').row!
    expect(applyWake(bed, local('2026-09-29', '01:00'), 'routine')).toBeNull()
    expect(applyWake(bed, local('2026-09-29', '06:52'), 'routine')?.wake_source).toBe('routine')
    expect(applyWake(null, local('2026-09-29', '06:52'), 'routine')).toBeNull()
  })
})

describe('streak', () => {
  const row = (night: string, late: number, woke = true): Sleep => ({
    night_of: night, bed_ts: `${night}T03:00:00.000Z`, wake_ts: woke ? `${night}T11:00:00.000Z` : null,
    bed_source: 'nfc', wake_source: woke ? 'routine' : null, target_bed: '23:00', late_min: late, updated_at: '', deleted_at: null,
  })
  it('counts consecutive confirmed on-time nights ending with the latest row', () => {
    expect(bedtimeStreak([row('2026-09-25', 5), row('2026-09-26', 0), row('2026-09-27', 15)], 15)).toBe(3)
    expect(bedtimeStreak([row('2026-09-25', 5), row('2026-09-26', 40), row('2026-09-27', 0)], 15)).toBe(1)
    expect(bedtimeStreak([row('2026-09-25', 5), row('2026-09-27', 0)], 15)).toBe(1) // gap breaks it
  })
  it('tonight\'s open row counts when on time, but an unconfirmed older night breaks the streak', () => {
    expect(bedtimeStreak([row('2026-09-26', 0), row('2026-09-27', 0, false)], 15)).toBe(2)
    expect(bedtimeStreak([row('2026-09-25', 0), row('2026-09-26', 0, false), row('2026-09-27', 0)], 15)).toBe(1)
  })
})
