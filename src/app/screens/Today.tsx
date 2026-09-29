// Today: routine circles, sleep card, check-in line, health strip. Everything above the fold on 375x812.
import { useState } from 'preact/hooks'
import type { RoutineItem, RoutineLog } from '@shared/types'
import { localDay, zonedToUTC } from '@shared/tz'
import { TopBar } from '../components/TopBar'
import { RoutineCircle } from '../components/RoutineCircle'
import { SleepCard } from '../components/SleepCard'
import { CheckinCard } from '../components/CheckinCard'
import { HealthStrip } from '../components/HealthStrip'
import { Sheet } from '../components/Sheet'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { navigate } from '../router'
import { dayLabel, durationLabel, hhmm, localHour } from '../data/format'
import { editRoutineTimes, loadError, loadToday, loading, now, syncState, tapRoutineLocal, today, undoRoutine } from '../data/store'
import { pending } from '../data/outbox'

export function Today() {
  const p = today.value
  const at = now.value
  const tz = p?.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const day = localDay(at, tz)
  const [editing, setEditing] = useState<RoutineItem | null>(null)

  const onTap = async (item: RoutineItem) => {
    try {
      const r = await tapRoutineLocal(item.id)
      toast(r.woke ? `${r.message} · good morning` : r.message)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Tap failed', { kind: 'danger' })
    }
  }

  return (
    <>
      <TopBar title={dayLabel(day)} onRefresh={() => void loadToday()} />
      <main class="content fade">
        <TokenBanner />
        {!p && loading.value && <div class="banner banner-info">Loading today…</div>}
        {!p && !loading.value && loadError.value && (
          <div class="banner banner-danger">
            <span class="grow"><strong>Can't reach the server.</strong> {loadError.value}</span>
            <button type="button" class="btn btn-sm" onClick={() => void loadToday()}>Retry</button>
          </div>
        )}
        {p && (
          <>
            <RoutineCard p={p} day={day} at={at} onTap={onTap} onLongPress={setEditing} />
            <SleepCard sleep={p.sleep} tz={p.tz} now={at} />
            <CheckinCard checkin={p.checkin} day={day} hour={localHour(at, p.tz)} />
            <RunningStrip p={p} at={at} />
            <HealthStrip health={p.health} pending={pending.value} now={at} />
          </>
        )}
      </main>
      {editing && p && (
        <RoutineEditSheet
          item={editing}
          log={p.routine_log.find((r) => r.local_day === day && r.item_id === editing.id && !r.deleted_at)}
          tz={p.tz}
          day={day}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

function TokenBanner() {
  const s = syncState.value
  if (s !== 'no-token' && s !== 'unauthorized') return null
  return (
    <div class="banner banner-danger">
      <span class="grow">
        <strong>{s === 'no-token' ? 'No app token yet.' : 'The app token was rejected.'}</strong>{' '}
        Paste your APP_TOKEN in Settings to load and sync.
      </span>
      <button type="button" class="btn btn-sm" onClick={() => navigate('#/settings')}>Settings</button>
    </div>
  )
}

function RoutineCard({ p, day, at, onTap, onLongPress }: {
  p: NonNullable<typeof today.value>
  day: string
  at: Date
  onTap: (item: RoutineItem) => void
  onLongPress: (item: RoutineItem) => void
}) {
  const logs = new Map(p.routine_log.filter((r) => r.local_day === day && !r.deleted_at).map((r) => [r.item_id, r]))
  const done = p.routine_items.filter((i) => logs.get(i.id)?.ended_at).length
  return (
    <section class="card" aria-label="Morning routine">
      <div class="card-head">
        <span class="card-title">Routine</span>
        <span class="small faint num">{done}/{p.routine_items.length} done</span>
      </div>
      {p.routine_items.length === 0 ? (
        <p class="muted small">No routine items yet. <a href="#/settings/routine">Add some</a>.</p>
      ) : (
        <div class="routine-row">
          {p.routine_items.map((item) => (
            <RoutineCircle
              key={item.id}
              item={item}
              log={logs.get(item.id)}
              tz={p.tz}
              now={at}
              onTap={() => onTap(item)}
              onLongPress={() => onLongPress(item)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function RunningStrip({ p, at }: { p: NonNullable<typeof today.value>; at: Date }) {
  const w = p.running.workout
  const s = p.running.session
  if (!w && !s) return null
  const since = (iso: string) => durationLabel((at.getTime() - new Date(iso).getTime()) / 60000)
  return (
    <div class="banner banner-info">
      <span class="grow small">
        {w && <span><span class="badge badge-workout">workout</span> {w.name ?? 'Workout'} running · {since(w.started_at)}</span>}
        {w && s && <br />}
        {s && <span><span class="badge">session</span> {s.project_name} · {since(s.started_at)}</span>}
      </span>
    </div>
  )
}

function RoutineEditSheet({ item, log, tz, day, onClose }: { item: RoutineItem; log: RoutineLog | undefined; tz: string; day: string; onClose: () => void }) {
  const [start, setStart] = useState(log ? hhmm(log.started_at, tz) : hhmm(new Date().toISOString(), tz))
  const [end, setEnd] = useState(log?.ended_at ? hhmm(log.ended_at, tz) : '')
  const save = async () => {
    if (!start) { toast('Start time is required', { kind: 'danger' }); return }
    const s = zonedToUTC(day, start, tz)
    let e: Date | null = end ? zonedToUTC(day, end, tz) : null
    if (e && e.getTime() <= s.getTime()) e = new Date(e.getTime() + 86400_000)
    await editRoutineTimes(item.id, s.toISOString(), e ? e.toISOString() : null)
    toast(`${item.name} ${e ? `${start}–${end}` : `started ${start}`}`)
    onClose()
  }
  const undo = async () => {
    await undoRoutine(item.id)
    toast(`${item.name} undone`)
    onClose()
  }
  return (
    <Sheet title={item.name} sub={log ? `Logged from ${log.source} · default ${item.default_min} min` : 'Not started yet · set the times by hand'} onClose={onClose}>
      <div class="stack">
        <div class="grid-2">
          <div class="field">
            <label for="rt-start">Start</label>
            <input id="rt-start" type="time" value={start} onInput={(e) => setStart((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label for="rt-end">End <span class="faint">(optional)</span></label>
            <input id="rt-end" type="time" value={end} onInput={(e) => setEnd((e.currentTarget as HTMLInputElement).value)} />
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-big btn-block" onClick={save}>
          <Icon name="check" size={20} /> Save times
        </button>
        {log && (
          <button type="button" class="btn btn-danger btn-block" onClick={undo}>
            <Icon name="trash" size={18} /> Undo today's {item.name.toLowerCase()}
          </button>
        )}
      </div>
    </Sheet>
  )
}
