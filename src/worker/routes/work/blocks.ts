// POST /api/time-blocks — the `planner block add` helper: manual blocks with times as ISO or local 'HH:MM' on a day.
import type { RouteContext } from '../../env'
import { json, readJson } from '../../http'
import { upsertFor } from '../../db'
import { localDay } from '../../../shared/tz'
import type { TimeBlock } from '../../../shared/types'
import { dirtyStmts, liveProjects, newProjectStmt } from './db'
import { matchProject, parseBlocksBody } from './parse'

/**
 * POST /api/time-blocks (app; CLI helper) — {blocks: [{start, end, category, label?, project?}], day?} -> 201 {ids}.
 * Categories are checked against the schema list; an unknown project name is created once for the whole request.
 */
export async function addTimeBlocks(c: RouteContext): Promise<Response> {
  const { env, now } = c
  const tz = env.TZ
  const { day, blocks } = parseBlocksBody(await readJson<unknown>(c.request), now, tz)
  const db = env.DB
  const nowIso = now.toISOString()
  const today = localDay(now, tz)

  // Resolve every distinct project reference against one read of the live list; create the unknown ones.
  const refs = [...new Set(blocks.map((b) => b.project).filter((p): p is string => p !== null))]
  const known = refs.length ? await liveProjects(db) : []
  const idFor = new Map<string, string>()
  const created: { id: string; name: string }[] = []
  for (const ref of refs) {
    const hit = matchProject(known, ref)
    if (hit) idFor.set(ref, hit.id)
    else {
      const dupe = created.find((p) => p.name.toLowerCase() === ref.toLowerCase())
      const id = dupe?.id ?? crypto.randomUUID()
      if (!dupe) created.push({ id, name: ref })
      idFor.set(ref, id)
    }
  }

  const rowsOut: TimeBlock[] = blocks.map((b) => ({
    id: crypto.randomUUID(),
    start_ts: b.start_ts,
    end_ts: b.end_ts,
    category: b.category,
    label: b.label,
    project_id: b.project ? (idFor.get(b.project) ?? null) : null,
    source: 'cli',
    created_at: nowIso,
    updated_at: nowIso,
    deleted_at: null,
  }))
  const days = new Set<string>()
  for (const r of rowsOut) {
    days.add(localDay(r.start_ts, tz))
    days.add(localDay(r.end_ts, tz))
  }
  await db.batch([
    ...created.map((p) => newProjectStmt(db, p.id, p.name, nowIso)),
    ...rowsOut.map((r) => {
      const up = upsertFor('time_blocks', r, false)
      return db.prepare(up.sql).bind(...up.params)
    }),
    ...dirtyStmts(db, days, today, nowIso),
  ])
  return json({ ids: rowsOut.map((r) => r.id), day, blocks: rowsOut, created_projects: created }, 201)
}
