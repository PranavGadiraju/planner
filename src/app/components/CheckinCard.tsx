// One-line check-ins: "Plan for today" before 11:00, "What got done today?" after 20:00. Dismissible per day.
import { useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import type { Checkin } from '@shared/types'
import { Icon } from './Icon'
import { toast } from './Toast'
import { saveCheckin } from '../data/store'

const dismissed = signal<Record<string, boolean>>({})
const key = (day: string, kind: string) => `planner.checkin.${day}.${kind}`

function isDismissed(day: string, kind: string): boolean {
  if (dismissed.value[key(day, kind)]) return true
  try { return localStorage.getItem(key(day, kind)) === '1' } catch { return false }
}
function dismiss(day: string, kind: string): void {
  try { localStorage.setItem(key(day, kind), '1') } catch { /* ignore */ }
  dismissed.value = { ...dismissed.value, [key(day, kind)]: true }
}

export function CheckinCard({ checkin, day, hour }: { checkin: Checkin | null; day: string; hour: number }) {
  const c = checkin && checkin.local_day === day && !checkin.deleted_at ? checkin : null
  const morning = hour < 11 && !c?.morning_at && !isDismissed(day, 'morning')
  const evening = hour >= 20 && !c?.evening_at && !isDismissed(day, 'evening')
  if (!morning && !evening) return null
  const kind = morning ? 'morning' : 'evening'
  return <CheckinLine key={`${day}-${kind}`} kind={kind} day={day} />
}

function CheckinLine({ kind, day }: { kind: 'morning' | 'evening'; day: string }) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const prompt = kind === 'morning' ? 'Plan for today' : 'What got done today?'
  const submit = async (e: Event) => {
    e.preventDefault()
    if (!note.trim()) return
    setBusy(true)
    try {
      await saveCheckin(kind, note)
      toast(kind === 'morning' ? 'Plan saved' : 'Evening note saved')
    } finally { setBusy(false) }
  }
  return (
    <form class="card" onSubmit={submit} aria-label={prompt}>
      <div class="card-head">
        <span class="card-title">{kind === 'morning' ? 'Morning' : 'Evening'}</span>
        <button type="button" class="icon-btn" style={{ width: 36, height: 36, marginRight: -8 }} aria-label="Dismiss for today" onClick={() => dismiss(day, kind)}>
          <Icon name="x" size={18} />
        </button>
      </div>
      <div class="row">
        <input
          class="grow"
          type="text"
          placeholder={prompt}
          value={note}
          onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)}
          enterkeyhint="done"
          autocomplete="off"
        />
        <button type="submit" class="btn btn-primary" disabled={busy || !note.trim()}>Save</button>
      </div>
    </form>
  )
}
