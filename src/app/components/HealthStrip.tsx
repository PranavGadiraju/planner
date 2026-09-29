// Small muted line: Mac push freshness, phone rows today, taps today, outbox, apps to triage.
import type { TodayPayload } from '@shared/types'
import { agoLabel, localHour } from '../data/format'
import { macStatus, phoneStatus } from '../data/apps'
import { tz } from '../data/store'
import '../styles/apps.css'

/** From this local hour on, a day without a single sticker tap is worth a warning (the stickers may be dead). */
export const NO_TAPS_WARN_HOUR = 11

export function HealthStrip({ health, pending, now }: { health: TodayPayload['health']; pending: number; now: Date }) {
  const zone = tz.value
  const mac = macStatus(health, now, zone)
  const phone = phoneStatus(health, now, zone)
  const macRow = health.rows.find((r) => r.source === 'mac')
  const triage = health.apps_to_triage
  const noTaps = health.taps_today === 0 && localHour(now, zone) >= NO_TAPS_WARN_HOUR
  return (
    <div class="health" aria-label="Automation health">
      <span class={mac.warn ? 'warn' : undefined}>{mac.text}</span>
      <span class={phone.warn ? 'warn' : undefined}>{phone.text}</span>
      {noTaps ? <span class="warn">no sticker taps yet today</span> : <span>Taps today: {health.taps_today}</span>}
      {pending > 0 && <span class="warn">Outbox: {pending} pending</span>}
      {triage > 0 && <a class="health-link" href="#/settings/apps">{triage} app{triage === 1 ? '' : 's'} to categorise</a>}
      {macRow?.last_error && <span class="warn" title={macRow.last_error}>Mac error {agoLabel(macRow.last_error_at, now)}</span>}
    </div>
  )
}
