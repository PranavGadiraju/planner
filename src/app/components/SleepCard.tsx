// Sleep card: summary line, "In bed" after 20:00, "I'm up" once a row has been open 3 h,
// and a "When did you wake?" chip when last night's row is still open after 11:00.
import { useState } from 'preact/hooks'
import type { Sleep, TodayPayload } from '@shared/types'
import { WAKE_MIN_MS, sleepDurationMin } from '@shared/sleep'
import { addDays, localDay, zonedToUTC } from '@shared/tz'
import { Icon } from './Icon'
import { toast } from './Toast'
import { durationLabel, hhmm, lateLabel, localHour } from '../data/format'
import { bedTapLocal, wakeLocal } from '../data/store'

function live(r: Sleep | null): Sleep | null {
  return r && !r.deleted_at ? r : null
}

export function SleepCard({ sleep, tz, now }: { sleep: TodayPayload['sleep']; tz: string; now: Date }) {
  const [wakeAt, setWakeAt] = useState('07:00')
  const [busy, setBusy] = useState(false)
  const open = live(sleep.open)
  const primary = open ?? live(sleep.tonight) ?? live(sleep.last_night)
  const hour = localHour(now, tz)
  const today = localDay(now, tz)

  const showBed = !open && (hour >= 20 || hour < 5)
  const showUp = !!open && now.getTime() - new Date(open.bed_ts).getTime() >= WAKE_MIN_MS
  const showWakeChip = !!open && open.night_of === addDays(today, -1) && hour >= 11

  const onBed = async () => {
    setBusy(true)
    try {
      const r = await bedTapLocal()
      toast(r.message)
    } finally { setBusy(false) }
  }
  const onUp = async () => {
    setBusy(true)
    try {
      const ok = await wakeLocal()
      toast(ok ? `Up ${hhmm(new Date().toISOString(), tz)}` : 'Nothing to close yet')
    } finally { setBusy(false) }
  }
  const onWakeAt = async () => {
    const at = zonedToUTC(today, wakeAt, tz)
    if (at.getTime() > now.getTime()) { toast('That is in the future', { kind: 'danger' }); return }
    const ok = await wakeLocal(at)
    toast(ok ? `Up ${wakeAt}` : 'Wake must be at least 3 h after bed', ok ? {} : { kind: 'danger' })
  }

  let line: preact.ComponentChildren
  if (!primary) {
    line = <span class="dim">No bed tap yet</span>
  } else {
    const dur = sleepDurationMin(primary)
    line = (
      <>
        <span>In bed {hhmm(primary.bed_ts, tz)}</span>
        <span class="dim"> ({lateLabel(primary.late_min)})</span>
        {primary.wake_ts && (
          <>
            <span class="sep">·</span>
            <span>up {hhmm(primary.wake_ts, tz)}</span>
            {dur !== null && <><span class="sep">·</span><span>{durationLabel(dur)}</span></>}
          </>
        )}
        {!primary.wake_ts && <><span class="sep">·</span><span class="dim">not up yet</span></>}
        <span class="sep">·</span>
        <span>streak {sleep.streak}</span>
      </>
    )
  }

  return (
    <section class="card" aria-label="Sleep">
      <div class="card-head">
        <span class="card-title">Sleep</span>
        {primary && <span class={`badge ${primary.late_min <= 0 ? 'badge-ok' : 'badge-sleep'}`}>{primary.late_min <= 0 ? 'on time' : lateLabel(primary.late_min)}</span>}
      </div>
      <p class="card-line num">{line}</p>
      {(showBed || showUp || showWakeChip) && (
        <div class="row-wrap" style={{ marginTop: '12px' }}>
          {showBed && (
            <button type="button" class="btn btn-sleep btn-big btn-block" onClick={onBed} disabled={busy}>
              <Icon name="moon" size={20} /> In bed
            </button>
          )}
          {showUp && (
            <button type="button" class="btn btn-primary btn-big grow" onClick={onUp} disabled={busy}>
              <Icon name="sun" size={20} /> I'm up
            </button>
          )}
          {showWakeChip && (
            <div class="wake-row">
              <span class="label">When did you wake?</span>
              <div class="row">
                <input class="grow" type="time" value={wakeAt} onInput={(e) => setWakeAt((e.currentTarget as HTMLInputElement).value)} aria-label="Wake time" />
                <button type="button" class="btn btn-ghost" onClick={onWakeAt}>Save</button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
