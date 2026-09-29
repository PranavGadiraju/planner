// Small muted line: Mac push freshness, taps today, outbox, apps to triage.
import type { TodayPayload } from '@shared/types'
import { agoLabel } from '../data/format'

export function HealthStrip({ health, pending, now }: { health: TodayPayload['health']; pending: number; now: Date }) {
  const mac = health.rows.find((r) => r.source === 'mac')
  const macAt = mac?.last_ok_at ?? health.mac_last_hour
  const macStale = macAt ? now.getTime() - new Date(macAt).getTime() > 3 * 3600_000 : false
  return (
    <div class="health" aria-label="Automation health">
      <span class={macStale ? 'warn' : undefined}>{macAt ? `Mac: last push ${agoLabel(macAt, now)}` : 'Mac: no data yet'}</span>
      <span>Taps today: {health.taps_today}</span>
      {pending > 0 && <span class="warn">Outbox: {pending} pending</span>}
      {health.apps_to_triage > 0 && <span>{health.apps_to_triage} apps to categorise</span>}
      {mac?.last_error && <span class="warn" title={mac.last_error}>Mac error {agoLabel(mac.last_error_at, now)}</span>}
    </div>
  )
}
