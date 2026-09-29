// The nightly cron's SQL and its rebuild plan, kept pure (no D1 globals) so vitest can check them; src/worker/cron.ts runs them.
import { addDays } from '../../../shared/tz'

export const AUTO_CLOSE_AFTER_MS = 3 * 3600_000
export const DIRTY_DRAIN_CAP = 5
export const TAP_LOG_KEEP = 500

// SQLite's date functions accept ISO-8601 with a trailing Z; %f prints seconds with milliseconds, so the output
// has the same shape as every other timestamp in the database.
const ISO_FMT = "'%Y-%m-%dT%H:%M:%fZ'"

/** Workouts open > 3 h: ended_at = last set + 2 min, or started_at + 3 h without sets. Marked ended_by 'auto'. */
export const AUTO_CLOSE_WORKOUTS_SQL =
  "UPDATE workouts SET ended_by = 'auto', updated_at = ?, ended_at = COALESCE(" +
  `(SELECT strftime(${ISO_FMT}, MAX(s.ts), '+2 minutes') FROM sets s WHERE s.workout_id = workouts.id AND s.deleted_at IS NULL), ` +
  `strftime(${ISO_FMT}, started_at, '+3 hours')) ` +
  'WHERE ended_at IS NULL AND deleted_at IS NULL AND started_at < ?'

/** Sessions open > 3 h: ended_at = started_at + 3 h, duration_s = 10800, ended_by 'auto'. */
export const AUTO_CLOSE_SESSIONS_SQL =
  `UPDATE sessions SET ended_by = 'auto', updated_at = ?, ended_at = strftime(${ISO_FMT}, started_at, '+3 hours'), duration_s = 10800 ` +
  'WHERE ended_at IS NULL AND deleted_at IS NULL AND started_at < ?'

/** Days whose rows the auto-close just touched (updated_at = this run) need a rebuild too. */
export const dirtyFromAutoCloseSql = (table: 'workouts' | 'sessions'): string =>
  `INSERT INTO dirty_days (local_day, marked_at) SELECT DISTINCT local_day, ? FROM ${table} WHERE ended_by = 'auto' AND updated_at = ? AND local_day < ? ` +
  'ON CONFLICT(local_day) DO UPDATE SET marked_at = excluded.marked_at'

export const PRUNE_TAP_LOG_SQL = `DELETE FROM tap_log WHERE id NOT IN (SELECT id FROM tap_log ORDER BY id DESC LIMIT ${TAP_LOG_KEEP})`
export const DIRTY_SQL = `SELECT local_day FROM dirty_days WHERE local_day < ? AND local_day NOT IN (?, ?) ORDER BY local_day LIMIT ${DIRTY_DRAIN_CAP}`
export const FINALISE_SQL = 'UPDATE day_summary SET final = 1 WHERE final = 0 AND local_day <= ?'
export const HEALTH_OK_SQL =
  "INSERT INTO automation_health (source, last_ok_at, detail) VALUES ('cron', ?, ?) " +
  'ON CONFLICT(source) DO UPDATE SET last_ok_at = excluded.last_ok_at, detail = excluded.detail'
export const HEALTH_ERROR_SQL =
  "INSERT INTO automation_health (source, last_error_at, last_error) VALUES ('cron', ?, ?) " +
  'ON CONFLICT(source) DO UPDATE SET last_error_at = excluded.last_error_at, last_error = excluded.last_error'

/** The days a run rebuilds: yesterday, the day before, then the dirty backlog (oldest first, capped), all < today. */
export function planRebuilds(today: string, dirty: readonly string[], cap = DIRTY_DRAIN_CAP): string[] {
  const fixed = [addDays(today, -1), addDays(today, -2)]
  const extra = dirty.filter((d) => d < today && !fixed.includes(d)).sort().slice(0, cap)
  return [...fixed, ...extra]
}
