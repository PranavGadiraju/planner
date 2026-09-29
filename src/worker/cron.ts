// Nightly cron (wrangler.jsonc triggers.crons: 5 8 * * * UTC = 04:05 New York). Also runnable on demand through
// POST /api/cron/run. Every step is SQL or a small batch: auto-close, prune and finalise are single statements,
// and the rebuilds are at most 2 + 10 rebuildDay calls (two D1 batches each), so a run stays inside 10 ms CPU.
// The SQL and the rebuild plan live in routes/rollup/nightly.ts (unit-tested); this file runs them.
import type { Env } from './env'
import { rebuildDay } from './rollup'
import {
  AUTO_CLOSE_AFTER_MS, AUTO_CLOSE_SESSIONS_SQL, AUTO_CLOSE_WORKOUTS_SQL, DIRTY_SQL, FINALISE_SQL, HEALTH_ERROR_SQL, HEALTH_OK_SQL,
  PRUNE_TAP_LOG_SQL, TAP_LOG_KEEP, dirtyFromAutoCloseSql, planRebuilds,
} from './routes/rollup/nightly'
import { addDays, localDay } from '../shared/tz'

export interface CronReport {
  today: string
  /** Human-readable steps, in order (also the automation_health detail). */
  ran: string[]
  rebuilt: string[]
  auto_closed: { workouts: number; sessions: number }
  finalised: number
  dirty_left: number
}

const changes = (r: D1Result<unknown> | undefined): number => Number(r?.meta?.changes ?? 0)
const rows = <T>(r: D1Result<unknown> | undefined): T[] => (r?.results ?? []) as T[]
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One run of the nightly work. Throws after recording the failure in automation_health. */
export async function runScheduled(env: Env, _controller?: ScheduledController): Promise<CronReport> {
  const now = new Date()
  const nowIso = now.toISOString()
  const today = localDay(now, env.TZ)
  const db = env.DB
  try {
    const staleBefore = new Date(now.getTime() - AUTO_CLOSE_AFTER_MS).toISOString()
    // 1. housekeeping in SQL: auto-close, mark their days dirty, prune, and read the dirty backlog.
    const [workoutsR, sessionsR, , , , dirtyR] = await db.batch([
      db.prepare(AUTO_CLOSE_WORKOUTS_SQL).bind(nowIso, staleBefore),
      db.prepare(AUTO_CLOSE_SESSIONS_SQL).bind(nowIso, staleBefore),
      db.prepare(dirtyFromAutoCloseSql('workouts')).bind(nowIso, nowIso, today),
      db.prepare(dirtyFromAutoCloseSql('sessions')).bind(nowIso, nowIso, today),
      db.prepare(PRUNE_TAP_LOG_SQL),
      db.prepare(DIRTY_SQL).bind(today, addDays(today, -1), addDays(today, -2)),
    ])
    const autoClosed = { workouts: changes(workoutsR), sessions: changes(sessionsR) }
    const dirty = rows<{ local_day: string }>(dirtyR).map((r) => r.local_day)

    // 2. rebuild D-1, D-2 and the dirty backlog (each rebuild is two batches; a few at a time for wall-clock).
    const days = planRebuilds(today, dirty)
    const rebuilt: string[] = []
    for (let i = 0; i < days.length; i += 4) {
      const chunk = days.slice(i, i + 4)
      await Promise.all(chunk.map((d) => rebuildDay(env, d, now)))
      rebuilt.push(...chunk)
    }

    // 3. finalise, count what is left, and report.
    const [finalR, leftR] = await db.batch([
      db.prepare(FINALISE_SQL).bind(addDays(today, -2)),
      db.prepare('SELECT COUNT(*) AS n FROM dirty_days WHERE local_day < ?').bind(today),
    ])
    const finalised = changes(finalR)
    const dirtyLeft = Number(rows<{ n: number }>(leftR)[0]?.n ?? 0)
    const ran = [
      `rebuilt ${plural(rebuilt.length, 'day')} (${rebuilt.slice(0, 2).join(', ')}${dirty.length ? ` + ${dirty.length} dirty` : ''})`,
      `auto-closed ${plural(autoClosed.workouts, 'workout')}, ${plural(autoClosed.sessions, 'session')}`,
      `finalised ${finalised}`,
      `tap_log pruned to ${TAP_LOG_KEEP}`,
    ]
    if (dirtyLeft) ran.push(`${plural(dirtyLeft, 'dirty day')} left for the next run`)
    await db.prepare(HEALTH_OK_SQL).bind(nowIso, ran.join('; ')).run()
    return { today, ran, rebuilt, auto_closed: autoClosed, finalised, dirty_left: dirtyLeft }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    try {
      await db.prepare(HEALTH_ERROR_SQL).bind(nowIso, msg.slice(0, 300)).run()
    } catch {
      /* the health row is best effort */
    }
    throw e
  }
}
