// Day rollups: one day_summary row per local day, computed from buildDay (the same pass the Day tab uses) plus a
// few SQL sums. A rebuild is one read batch (every buildDay source + the aggregates, via loadDayInput's `extra`)
// and one write batch (the upsert + the dirty_days delete), never a loop over rows in JS.
// The row's shape and the pure math live in routes/rollup/summary.ts (unit-tested); this file does the I/O.
import type { Env } from './env'
import { loadDayInput } from './routes/day'
import { AGGREGATE_SQL, SUMMARY_UPSERT_SQL, composeSummary, parseAggregates, summaryParams } from './routes/rollup/summary'
import type { DaySummary } from './routes/rollup/summary'
import { buildDay } from '../shared/day'
import { localDay } from '../shared/tz'

export type { DaySummary, DaySummaryRow } from './routes/rollup/summary'
export { SUMMARY_SELECT_SQL, emptySummary, rowToSummary } from './routes/rollup/summary'

/** Load + buildDay + sums for one day (one D1 batch). Nothing is written; today's live summary uses this too. */
export async function computeSummary(env: Env, day: string, now: Date): Promise<DaySummary> {
  const db = env.DB
  const { input, items, extra } = await loadDayInput(env, day, now, AGGREGATE_SQL.map((sql) => db.prepare(sql).bind(day)))
  const result = buildDay(input)
  const night = input.sleep.find((s) => s.night_of === day && !s.deleted_at) ?? null
  return composeSummary(day, result, parseAggregates(extra), {
    routine_done: input.routine_log.filter((r) => !r.deleted_at).length,
    routine_total: items.filter((i) => Number(i.active) === 1).length,
    bed_late_min: night ? Number(night.late_min) || 0 : null,
    today: localDay(now, env.TZ),
    nowIso: now.toISOString(),
  })
}

/** Rebuild one past day's day_summary row and clear its dirty_days mark. Two D1 batches, no per-row work. */
export async function rebuildDay(env: Env, day: string, now: Date): Promise<DaySummary> {
  const summary = await computeSummary(env, day, now)
  const db = env.DB
  await db.batch([
    db.prepare(SUMMARY_UPSERT_SQL).bind(...summaryParams(summary)),
    db.prepare('DELETE FROM dirty_days WHERE local_day = ?').bind(day),
  ])
  return summary
}
