// Exercise progress ('#/lift/e/<id>'): e1RM line with PR dots, volume bars, range chips, tap-a-session sets,
// the last 10 sessions table, Edit exercise and Merge into another exercise.
import { useEffect, useState } from 'preact/hooks'
import type { Exercise } from '@shared/types'
import { SubBar } from '../../components/TopBar'
import { Icon } from '../../components/Icon'
import { Sheet } from '../../components/Sheet'
import { toast } from '../../components/Toast'
import { ApiError } from '../../data/api'
import { navigate } from '../../router'
import { dayLabel } from '../../data/format'
import { settings } from '../../data/store'
import {
  HISTORY_RANGES, exercises, fmtVolume, fmtWeight, loadExercises, loadHistory, mergeExercise, type HistoryPayload, type HistoryRange, type HistorySession,
} from '../../data/lift'
import { E1rmChart, VolumeChart } from './Charts'
import { ExercisePicker, ExerciseSheet } from './ExercisePicker'

const RANGE_LABEL: Record<HistoryRange, string> = { '1m': '1M', '3m': '3M', '1y': '1Y', all: 'All' }

export function ExerciseProgress({ id }: { id: string }) {
  const [range, setRange] = useState<HistoryRange>('3m')
  const [data, setData] = useState<HistoryPayload | null>(null)
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [merging, setMerging] = useState(false)
  const unit = settings.value.weight_unit

  const load = async (r: HistoryRange) => {
    setError(null)
    try {
      const res = await loadHistory(id, r)
      setData(res.data)
      setCached(res.cached)
      const last = res.data.sessions[res.data.sessions.length - 1]
      setSelected((cur) => (cur && res.data.sessions.some((s) => s.workout_id === cur) ? cur : last?.workout_id ?? null))
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 404 ? 'No such exercise.' : err.message) : 'Cannot reach the server')
    }
  }
  useEffect(() => { setData(null); void load(range); void loadExercises() }, [id, range])

  // Prefer the freshest copy of the exercise row (an edit is applied optimistically to the exercises signal).
  const ex: Exercise | null = exercises.value.find((e) => e.id === id) ?? data?.exercise ?? null
  const sessions = data?.sessions ?? []
  const sel = sessions.find((s) => s.workout_id === selected) ?? null
  const lastTen = [...sessions].reverse().slice(0, 10)
  const best = sessions.reduce<number | null>((b, s) => (s.best_e1rm !== null && (b === null || s.best_e1rm > b) ? s.best_e1rm : b), null)

  return (
    <>
      <SubBar
        title={ex?.name ?? 'Exercise'}
        fallback="#/lift"
        right={<button type="button" class="icon-btn" onClick={() => setEditing(true)} aria-label="Edit exercise" disabled={!ex}><Icon name="edit" /></button>}
      />
      <main class="content fade">
        {cached && <div class="banner banner-info small">Offline · showing cached history.</div>}
        {error && <div class="banner banner-danger"><span class="grow">{error}</span><button type="button" class="btn btn-sm" onClick={() => void load(range)}>Retry</button></div>}
        <div class="range-chips" role="group" aria-label="Range">
          {HISTORY_RANGES.map((r) => (
            <button key={r} type="button" aria-pressed={range === r} onClick={() => setRange(r)}>{RANGE_LABEL[r]}</button>
          ))}
        </div>
        <section class="card" aria-label="Estimated one-rep max">
          <div class="chart-title">
            <span class="card-title">e1RM</span>
            {best !== null && <b class="num">best {Math.round(best)} {unit}</b>}
          </div>
          {data ? <E1rmChart sessions={sessions} selected={selected} onSelect={(s) => setSelected(s.workout_id)} /> : <div class="chart-empty">Loading…</div>}
        </section>
        <section class="card" aria-label="Volume">
          <div class="chart-title">
            <span class="card-title">Volume</span>
            {sessions.length > 0 && <b class="num">{sessions.length} session{sessions.length === 1 ? '' : 's'}</b>}
          </div>
          {data ? <VolumeChart sessions={sessions} selected={selected} onSelect={(s) => setSelected(s.workout_id)} /> : <div class="chart-empty">Loading…</div>}
          {sel && <SelectedSession s={sel} unit={unit} />}
        </section>
        {lastTen.length > 0 && (
          <section class="card" style={{ padding: '4px 8px' }} aria-label="Last sessions">
            <table class="table prog-table">
              <thead><tr><th>Date</th><th>Top set</th><th>Reps</th><th>Volume</th></tr></thead>
              <tbody>
                {lastTen.map((s) => (
                  <tr key={s.workout_id} data-sel={s.workout_id === selected} onClick={() => setSelected(s.workout_id)}>
                    <td class="num">{dayLabel(s.local_day)}{s.is_pr && <span class="badge badge-pr" style={{ marginLeft: '6px' }}>PR</span>}</td>
                    <td class="num">{s.top_set ? `${fmtWeight(s.top_set.weight)}×${s.top_set.reps}` : '—'}</td>
                    <td class="num">{s.total_reps}</td>
                    <td class="num">{Math.round(s.volume).toLocaleString('en-US')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        {data && sessions.length === 0 && <p class="lift-empty">No sessions in this range{range !== 'all' ? ' — try All' : ''}.</p>}
        <div class="ex-actions">
          <button type="button" class="btn btn-ghost" onClick={() => setEditing(true)} disabled={!ex}><Icon name="edit" size={18} /> Edit</button>
          <button type="button" class="btn btn-ghost" onClick={() => setMerging(true)} disabled={!ex}><Icon name="link" size={18} /> Merge into…</button>
        </div>
      </main>
      {editing && ex && <ExerciseSheet exercise={ex} onSaved={() => {}} onClose={() => setEditing(false)} />}
      {merging && ex && <MergeSheet from={ex} onClose={() => setMerging(false)} />}
    </>
  )
}

function SelectedSession({ s, unit }: { s: HistorySession; unit: string }) {
  return (
    <div style={{ marginTop: '10px' }}>
      <div class="row small muted" style={{ justifyContent: 'space-between' }}>
        <span><b style={{ color: 'var(--text)' }}>{dayLabel(s.local_day)}</b>{s.name ? ` · ${s.name}` : ''}{s.is_pr && <span class="badge badge-pr" style={{ marginLeft: '6px' }}>PR</span>}</span>
        <a href={`#/lift/s/${s.workout_id}`} class="row" style={{ gap: '2px' }}>Open <Icon name="chevron" size={14} /></a>
      </div>
      <div class="sel-sets">
        {s.sets.map((x) => (
          <span key={x.id} class="sel-set" data-warm={x.is_warmup === 1}>{fmtWeight(x.weight)}×{x.reps}{x.is_warmup === 1 ? ' w' : ''}</span>
        ))}
      </div>
      <p class="small faint num" style={{ marginTop: '8px' }}>
        {s.best_e1rm !== null ? `e1RM ${Math.round(s.best_e1rm)} · ` : ''}{fmtVolume(s.volume, unit)} · {s.total_reps} reps
      </p>
    </div>
  )
}

function MergeSheet({ from, onClose }: { from: Exercise; onClose: () => void }) {
  const [into, setInto] = useState<Exercise | null>(null)
  const [busy, setBusy] = useState(false)
  const merge = async () => {
    if (!into || busy) return
    setBusy(true)
    try {
      const all = await loadHistory(from.id, 'all')
      if (all.cached) { toast('Merging needs a connection (the full history must be fresh)', { kind: 'danger' }); return }
      const n = await mergeExercise(from, into, all.data.sessions)
      toast(`Moved ${n} set${n === 1 ? '' : 's'} into ${into.name}`)
      onClose()
      navigate(`#/lift/e/${into.id}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Merge failed', { kind: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title={`Merge “${from.name}” into…`} sub="Every set moves to the other exercise and this one is removed. Use it to fold a duplicate name back in." onClose={onClose}>
      {!into ? (
        <ExercisePicker exclude={[from.id]} allowCreate={false} onPick={setInto} placeholder="Find the exercise to keep" />
      ) : (
        <div class="stack-sm">
          <p class="card-line">Move all sets of <b>{from.name}</b> into <b>{into.name}</b>?</p>
          <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => void merge()} disabled={busy}><Icon name="link" size={18} /> Merge</button>
          <button type="button" class="btn btn-ghost btn-block" onClick={() => setInto(null)} disabled={busy}>Pick another</button>
        </div>
      )}
    </Sheet>
  )
}
