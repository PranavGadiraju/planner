// One-line check-ins: "Plan for today" before 11:00, "What got done today?" after 20:00. Dismissible per day.
// The evening line is pre-filled from today's sessions (with notes), workouts and the routine tally; the user can
// edit it before saving. The morning line stays empty.
import { useEffect, useState } from 'preact/hooks'
import { signal } from '@preact/signals'
import type { Checkin } from '@shared/types'
import { Icon } from './Icon'
import { toast } from './Toast'
import { now, saveCheckin, today } from '../data/store'
import { dayState } from '../data/day'
import { checkinSummary, loadTodaySessions, sessionsDay, todaySessions, workoutNames } from '../data/work'

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

/** The evening pre-fill, recomputed as sessions, the day chart and the clock change. '' for the morning. */
function useSuggestion(kind: 'morning' | 'evening', day: string): string {
  const p = today.value
  const sessions = todaySessions.value
  const loadedDay = sessionsDay.value
  const blocks = dayState(day).value.data?.blocks ?? []
  const at = now.value
  useEffect(() => {
    if (kind === 'evening' && loadedDay !== day) void loadTodaySessions()
  }, [kind, day, loadedDay])
  if (kind !== 'evening' || !p) return ''
  return checkinSummary(p, loadedDay === day ? sessions : [], workoutNames(blocks), day, at)
}

function CheckinLine({ kind, day }: { kind: 'morning' | 'evening'; day: string }) {
  const suggestion = useSuggestion(kind, day)
  const [note, setNote] = useState(suggestion)
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  // Follow the suggestion until the user edits the line (sessions may load a moment after the card).
  useEffect(() => { if (!touched) setNote(suggestion) }, [suggestion, touched])
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
          onInput={(e) => { setNote((e.currentTarget as HTMLInputElement).value); setTouched(true) }}
          enterkeyhint="done"
          autocomplete="off"
          aria-label={prompt}
        />
        <button type="submit" class="btn btn-primary" disabled={busy || !note.trim()}>Save</button>
      </div>
    </form>
  )
}
