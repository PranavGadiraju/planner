// D1 helpers shared by the Work routes: result unwrapping, the live project list used to resolve a name|id, the
// project-creating INSERT (position = max + 1 in SQL, no extra query) and dirty_days marks for past-day rows.
import type { ProjectRef } from './parse'

export function rows<T>(r: D1Result<unknown> | undefined): T[] {
  return (r?.results ?? []) as T[]
}

export interface LiveProject extends ProjectRef { kind: 'project' | 'study'; color: string | null }

export const LIVE_PROJECTS_SQL = 'SELECT id, name, kind, color, position, archived_at FROM projects WHERE deleted_at IS NULL ORDER BY position, name'

export async function liveProjects(db: D1Database): Promise<LiveProject[]> {
  const { results } = await db.prepare(LIVE_PROJECTS_SQL).all<LiveProject>()
  return results
}

/** INSERT a new project at the end of the list (server-authoritative: no updated_at guard needed on a fresh id). */
export function newProjectStmt(db: D1Database, id: string, name: string, nowIso: string): D1PreparedStatement {
  return db
    .prepare(
      "INSERT INTO projects (id, name, kind, color, position, archived_at, created_at, updated_at, deleted_at) " +
        'VALUES (?, ?, ?, NULL, (SELECT COALESCE(MAX(position), 0) + 1 FROM projects), NULL, ?, ?, NULL)',
    )
    .bind(id, name, 'project', nowIso, nowIso)
}

const DIRTY_SQL = 'INSERT INTO dirty_days (local_day, marked_at) VALUES (?, ?) ON CONFLICT(local_day) DO UPDATE SET marked_at = excluded.marked_at'

/** One dirty_days mark per distinct past day (days before `today`), so the rollup cron rebuilds them. */
export function dirtyStmts(db: D1Database, days: Iterable<string>, today: string, nowIso: string): D1PreparedStatement[] {
  const past = new Set<string>()
  for (const d of days) if (d < today) past.add(d)
  return [...past].map((d) => db.prepare(DIRTY_SQL).bind(d, nowIso))
}
