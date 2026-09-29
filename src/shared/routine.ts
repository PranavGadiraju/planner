import type { RoutineLog, Source } from './types'

export const ROUTINE_DUP_MS = 2 * 60_000
export const ROUTINE_FINISH_MS = 3 * 60_000

export type RoutineTapAction = 'routine_started' | 'routine_duplicate' | 'routine_ignored' | 'routine_finished' | 'routine_already_done'
export interface RoutineTapResult { action: RoutineTapAction; row: RoutineLog; changed: boolean }

/**
 * First tap of the day starts the item; a second tap >= 3 min later ends it; taps < 2 min apart are duplicates;
 * taps between 2 and 3 min are ignored; anything after the item is finished is "already done".
 * A tombstoned row (undone in the app) is re-activated by a new tap.
 */
export function applyRoutineTap(
  existing: RoutineLog | null,
  now: Date,
  ctx: { local_day: string; item_id: string; source: Source },
): RoutineTapResult {
  const nowIso = now.toISOString()
  if (!existing || existing.deleted_at) {
    return {
      action: 'routine_started',
      changed: true,
      row: { local_day: ctx.local_day, item_id: ctx.item_id, started_at: nowIso, ended_at: null, source: ctx.source, updated_at: nowIso, deleted_at: null },
    }
  }
  if (existing.ended_at) return { action: 'routine_already_done', row: existing, changed: false }
  const delta = now.getTime() - new Date(existing.started_at).getTime()
  if (delta < ROUTINE_DUP_MS) return { action: 'routine_duplicate', row: existing, changed: false }
  if (delta < ROUTINE_FINISH_MS) return { action: 'routine_ignored', row: existing, changed: false }
  return { action: 'routine_finished', changed: true, row: { ...existing, ended_at: nowIso, updated_at: nowIso } }
}

export function routineDurationMin(row: RoutineLog, defaultMin: number): number {
  if (row.ended_at) return Math.max(1, Math.round((new Date(row.ended_at).getTime() - new Date(row.started_at).getTime()) / 60000))
  return defaultMin
}
