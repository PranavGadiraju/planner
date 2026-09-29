// GET /api/export (app): every table as JSON rows, one D1 batch, capped at EXPORT_ROW_CAP rows per table (the cap
// is reported so a truncated dump is never mistaken for a full one). `planner export` writes this to a file.
import type { RouteContext } from '../../env'
import { json } from '../../http'
import { EXPORT_ROW_CAP, EXPORT_TABLES } from './tables'

export interface ExportResponse {
  exported_at: string
  /** Rows per table are capped here; `truncated` lists the tables that hit it. */
  row_cap: number
  truncated: string[]
  counts: Record<string, number>
  tables: Record<string, Record<string, unknown>[]>
}

export async function exportAll(c: RouteContext): Promise<Response> {
  const db = c.env.DB
  const results = await db.batch(EXPORT_TABLES.map((t) => db.prepare(`SELECT * FROM ${t} LIMIT ${EXPORT_ROW_CAP}`)))
  const tables: ExportResponse['tables'] = {}
  const counts: Record<string, number> = {}
  const truncated: string[] = []
  EXPORT_TABLES.forEach((t, i) => {
    const rows = (results[i]?.results ?? []) as Record<string, unknown>[]
    tables[t] = rows
    counts[t] = rows.length
    if (rows.length >= EXPORT_ROW_CAP) truncated.push(t)
  })
  const res: ExportResponse = { exported_at: c.now.toISOString(), row_cap: EXPORT_ROW_CAP, truncated, counts, tables }
  return json(res)
}
