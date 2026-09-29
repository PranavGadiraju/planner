// Nightly cron (wrangler.jsonc triggers.crons, UTC). Milestone 7 adds day_summary rollups, dirty_days draining and auto-close.
import type { Env } from './env'

/** Nightly cron (5 8 * * * UTC). This milestone only prunes tap_log to its last 500 rows. */
export async function runScheduled(env: Env, _controller?: ScheduledController): Promise<void> {
  const nowIso = new Date().toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tap_log WHERE id NOT IN (SELECT id FROM tap_log ORDER BY id DESC LIMIT 500)'),
    env.DB
      .prepare("INSERT INTO automation_health (source, last_ok_at, detail) VALUES ('cron', ?, 'tap_log pruned') ON CONFLICT(source) DO UPDATE SET last_ok_at = excluded.last_ok_at, detail = excluded.detail")
      .bind(nowIso),
  ])
}

