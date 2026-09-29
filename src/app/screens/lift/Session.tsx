// Session detail ('#/lift/s/<id>'): a finished workout's exercises and sets with PR badges, "Repeat this", delete.
import { useEffect, useState } from 'preact/hooks'
import type { Exercise } from '@shared/types'
import { SubBar } from '../../components/TopBar'
import { Icon } from '../../components/Icon'
import { Sheet } from '../../components/Sheet'
import { toast } from '../../components/Toast'
import { ApiError } from '../../data/api'
import { navigate } from '../../router'
import { dayLabel, hhmm } from '../../data/format'
import { now, settings, tz } from '../../data/store'
import {
  deleteWorkout, fmtMinutes, fmtVolume, fmtWeight, isPR, loadWorkoutDetail, loadWorkouts, startWorkout, templateExerciseOrder, workoutMinutes, workoutStats,
  type SetWithPrior, type WorkoutDetail,
} from '../../data/lift'
import { runningWorkout } from './Home'

export function SessionDetail({ id }: { id: string }) {
  const [d, setD] = useState<WorkoutDetail | null>(null)
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const unit = settings.value.weight_unit
  const zone = tz.value

  const load = async () => {
    setError(null)
    try {
      const r = await loadWorkoutDetail(id)
      setD(r.data)
      setCached(r.cached)
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 404 ? 'No such workout.' : err.message) : 'Cannot reach the server')
    }
  }
  useEffect(() => { setD(null); void load() }, [id])

  const repeat = async () => {
    if (!d) return
    const running = runningWorkout()
    if (running) { toast('Finish the running workout first'); navigate(`#/lift/w/${running.id}`); return }
    const w = await startWorkout(d.workout.name, { workout: d.workout, sets: d.sets, exercises: d.exercises })
    toast(`${w.name ?? 'Workout'} · ${templateExerciseOrder(d.sets).length} exercises`)
    navigate(`#/lift/w/${w.id}`)
  }
  const remove = async () => {
    if (!d) return
    await deleteWorkout(d.workout)
    toast('Workout deleted')
    setConfirm(false)
    navigate('#/lift')
    void loadWorkouts()
  }

  const w = d?.workout
  const stats = d ? workoutStats(d.sets) : null
  const groups = d ? groupByExercise(d.sets, d.exercises) : []
  const prs = d ? d.sets.filter((s) => isPR(s, s.prior_best)).length : 0
  return (
    <>
      <SubBar title={w ? w.name ?? 'Workout' : 'Workout'} fallback="#/lift" right={w && !w.ended_at ? <a class="btn btn-sm btn-primary" href={`#/lift/w/${w.id}`}>Resume</a> : undefined} />
      <main class="content fade">
        {cached && <div class="banner banner-info small">Offline · showing the cached session.</div>}
        {!d && !error && <div class="banner banner-info">Loading…</div>}
        {error && <div class="banner banner-danger"><span class="grow">{error}</span><button type="button" class="btn btn-sm" onClick={() => void load()}>Retry</button></div>}
        {d && w && stats && (
          <>
            <section class="card" aria-label="Summary">
              <div class="sess-hero num">
                <b>{dayLabel(w.local_day)}</b>
                <span>{hhmm(w.started_at, zone)}{w.ended_at ? `–${hhmm(w.ended_at, zone)}` : ' · running'}</span>
                <span>{fmtMinutes(workoutMinutes(w, now.value))}</span>
                <span>{stats.sets} set{stats.sets === 1 ? '' : 's'}</span>
                <span>{fmtVolume(stats.volume, unit)}</span>
                {prs > 0 && <span class="badge badge-pr">{prs} PR{prs === 1 ? '' : 's'}</span>}
                {w.ended_by === 'auto' && <span class="badge badge-auto">auto-closed</span>}
              </div>
              {w.note && <p class="small muted" style={{ marginTop: '8px' }}>{w.note}</p>}
            </section>
            {groups.length === 0 && <p class="lift-empty">No sets were logged.</p>}
            {groups.map((g) => (
              <section key={g.id} class="card" aria-label={g.name}>
                <div class="sess-ex">
                  <a href={`#/lift/e/${g.id}`}>{g.name}</a>
                  <span class="small faint num">{g.sets.filter((s) => !s.is_warmup).length} sets · {fmtVolume(g.sets.reduce((v, s) => v + (s.is_warmup ? 0 : s.reps * s.weight), 0), unit)}</span>
                </div>
                <div class="set-list">
                  {g.sets.map((s) => (
                    <div key={s.id} class="set-row" data-warm={s.is_warmup === 1}>
                      <span class="set-no">{s.set_no}</span>
                      <span class="set-val">{fmtWeight(s.weight)}<span class="dim">×</span>{s.reps}</span>
                      {s.is_warmup === 1 && <span class="badge badge-warm">warm-up</span>}
                      {isPR(s, s.prior_best) && <span class="badge badge-pr">PR</span>}
                      <span class="set-time">{hhmm(s.ts, zone)}</span>
                    </div>
                  ))}
                </div>
              </section>
            ))}
            <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => void repeat()}>
              <Icon name="refresh" size={20} /> Repeat this
            </button>
            <button type="button" class="btn btn-ghost btn-block" onClick={() => setConfirm(true)}>
              <Icon name="trash" size={18} /> Delete workout
            </button>
          </>
        )}
      </main>
      {confirm && w && (
        <Sheet title="Delete this workout?" sub="It disappears from history and the day chart. Its sets stop counting for PRs." onClose={() => setConfirm(false)}>
          <div class="stack-sm">
            <button type="button" class="btn btn-danger btn-big btn-block" onClick={() => void remove()}><Icon name="trash" size={18} /> Delete</button>
            <button type="button" class="btn btn-ghost btn-block" onClick={() => setConfirm(false)}>Keep</button>
          </div>
        </Sheet>
      )}
    </>
  )
}

function groupByExercise(sets: SetWithPrior[], exercises: Exercise[]): { id: string; name: string; sets: SetWithPrior[] }[] {
  const names = new Map(exercises.map((e) => [e.id, e.name]))
  const out: { id: string; name: string; sets: SetWithPrior[] }[] = []
  for (const s of sets) {
    let g = out.find((x) => x.id === s.exercise_id)
    if (!g) { g = { id: s.exercise_id, name: names.get(s.exercise_id) ?? 'Exercise', sets: [] }; out.push(g) }
    g.sets.push(s)
  }
  for (const g of out) g.sets.sort((a, b) => a.set_no - b.set_no)
  return out
}
