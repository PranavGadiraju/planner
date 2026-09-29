// POST /api/write — batched idempotent upserts from the app's outbox, guarded by updated_at (last writer wins,
// a stale replay never reverts a newer edit). Past-day rows are recorded in dirty_days and their day_summary is
// rebuilt after the response (ctx.waitUntil), so week totals never go stale after a gap fill; the dirty_days mark
// stays as the fallback the cron drains if that rebuild fails.
import type { RouteContext } from '../env'
import { HttpError, errorMessage, isRecord, json, readJson } from '../http'
import { buildUpsertSql, validateRow } from '../db'
import { rebuildDay } from '../rollup'
import { rowDays } from './rollup/summary'
import { localDay } from '../../shared/tz'
import type { WriteResponse } from '../../shared/types'

export const MAX_WRITE_ROWS = 200
/** Past days rebuilt in the background per write; anything beyond waits for the cron (dirty_days). */
export const MAX_REBUILDS_PER_WRITE = 5

/** `days`: every local day the row can change (routes/rollup/summary.ts rowDays), for dirty_days and the rebuilds. */
interface Planned { table: string; key: string; days: string[]; stmt: D1PreparedStatement }

/** Parent tables first when rows are applied one by one (foreign keys: sets -> workouts/exercises, sessions -> projects, ...). */
const TABLE_RANK: Record<string, number> = { projects: 0, foods: 0, exercises: 0, routine_items: 0, settings: 0, app_categories: 0, workouts: 1, meals: 1, sessions: 2, time_blocks: 2, sets: 2, meal_items: 2, food_log: 2 }
const tableRank = (t: string): number => TABLE_RANK[t] ?? 1
const DIRTY_SQL = 'INSERT INTO dirty_days (local_day, marked_at) VALUES (?, ?) ON CONFLICT(local_day) DO UPDATE SET marked_at = excluded.marked_at'

export async function write(c: RouteContext): Promise<Response> {
  const { env, now } = c
  const body = await readJson<unknown>(c.request)
  if (!isRecord(body) || !Array.isArray(body['mutations'])) throw new HttpError(400, 'mutations[] required')
  const tz = env.TZ
  const today = localDay(now, tz)
  const nowIso = now.toISOString()
  const db = env.DB

  const plan: Planned[] = []
  const rejected: WriteResponse['rejected'] = []
  let total = 0
  for (const m of body['mutations'] as unknown[]) {
    if (!isRecord(m) || typeof m['table'] !== 'string' || !Array.isArray(m['rows'])) {
      throw new HttpError(400, 'each mutation needs {table, rows[]}')
    }
    const table = m['table']
    total += m['rows'].length
    if (total > MAX_WRITE_ROWS) throw new HttpError(400, `at most ${MAX_WRITE_ROWS} rows per request`)
    for (const raw of m['rows'] as unknown[]) {
      if (!isRecord(raw)) {
        rejected.push({ table, key: '?', reason: 'row must be an object' })
        continue
      }
      const check = validateRow(table, raw)
      if (!check.ok) {
        rejected.push({ table, key: check.key, reason: check.reason })
        continue
      }
      plan.push({
        table, key: check.key, days: rowDays(table, raw, tz),
        stmt: db.prepare(buildUpsertSql(table, check.columns)).bind(...check.params),
      })
    }
  }

  const dirtyDays = (rows: Planned[]): string[] => {
    const days = new Set<string>()
    for (const p of rows) for (const d of p.days) if (d < today) days.add(d)
    return [...days].sort()
  }
  const dirtyStmts = (days: string[]): D1PreparedStatement[] => days.map((d) => db.prepare(DIRTY_SQL).bind(d, nowIso))

  let applied = 0
  let dirty: string[] = []
  if (plan.length) {
    try {
      // One transactional batch: rows plus their dirty-day marks.
      dirty = dirtyDays(plan)
      // Foreign keys are checked at commit, so a child row may precede its parent inside one batch.
      await db.batch([db.prepare('PRAGMA defer_foreign_keys = ON'), ...plan.map((p) => p.stmt), ...dirtyStmts(dirty)])
      applied = plan.length
    } catch {
      // Something in the batch failed (constraint, bad enum, FK...). Apply row by row and report each failure.
      const ok: Planned[] = []
      for (const p of [...plan].sort((a, b) => tableRank(a.table) - tableRank(b.table))) {
        try {
          await p.stmt.run()
          ok.push(p)
        } catch (e) {
          rejected.push({ table: p.table, key: p.key, reason: errorMessage(e) })
        }
      }
      applied = ok.length
      dirty = dirtyDays(ok)
      if (dirty.length) await db.batch(dirtyStmts(dirty))
    }
  }
  // Rebuild the touched past days after the response; a failure leaves the dirty_days mark for the cron.
  for (const d of dirty.slice(0, MAX_REBUILDS_PER_WRITE)) {
    c.ctx.waitUntil(rebuildDay(env, d, now).catch((e: unknown) => console.warn('rebuild after write failed', d, errorMessage(e))))
  }
  const res: WriteResponse = { applied, rejected }
  return json(res)
}
