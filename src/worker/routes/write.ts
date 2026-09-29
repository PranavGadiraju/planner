// POST /api/write — batched idempotent upserts from the app's outbox, guarded by updated_at (last writer wins,
// a stale replay never reverts a newer edit). Past-day rows are recorded in dirty_days for the rollup cron.
import type { RouteContext } from '../env'
import { HttpError, errorMessage, isRecord, json, readJson } from '../http'
import { buildUpsertSql, rowLocalDay, validateRow } from '../db'
import { localDay } from '../../shared/tz'
import type { WriteResponse } from '../../shared/types'

export const MAX_WRITE_ROWS = 200

interface Planned { table: string; key: string; day: string | null; stmt: D1PreparedStatement }

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
        table, key: check.key, day: rowLocalDay(table, raw, tz),
        stmt: db.prepare(buildUpsertSql(table, check.columns)).bind(...check.params),
      })
    }
  }

  const dirtyStmts = (rows: Planned[]): D1PreparedStatement[] => {
    const days = new Set<string>()
    for (const p of rows) if (p.day && p.day < today) days.add(p.day)
    return [...days].map((d) => db.prepare(DIRTY_SQL).bind(d, nowIso))
  }

  let applied = 0
  if (plan.length) {
    try {
      // One transactional batch: rows plus their dirty-day marks.
      await db.batch([...plan.map((p) => p.stmt), ...dirtyStmts(plan)])
      applied = plan.length
    } catch {
      // Something in the batch failed (constraint, bad enum, FK...). Apply row by row and report each failure.
      const ok: Planned[] = []
      for (const p of plan) {
        try {
          await p.stmt.run()
          ok.push(p)
        } catch (e) {
          rejected.push({ table: p.table, key: p.key, reason: errorMessage(e) })
        }
      }
      applied = ok.length
      const dirty = dirtyStmts(ok)
      if (dirty.length) await db.batch(dirty)
    }
  }
  const res: WriteResponse = { applied, rejected }
  return json(res)
}
