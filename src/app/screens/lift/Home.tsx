// Lift home: resume banner, template chips (last 5 names + Empty / a new name), history grouped by month.
// '#/lift/start' (Today's quick action) opens the same chips in a sheet.
import { useEffect, useState } from 'preact/hooks'
import type { Workout } from '@shared/types'
import { TopBar } from '../../components/TopBar'
import { Icon } from '../../components/Icon'
import { Sheet } from '../../components/Sheet'
import { toast } from '../../components/Toast'
import { navigate } from '../../router'
import { dayLabel, elapsedLabel } from '../../data/format'
import { now, settings, syncState, today } from '../../data/store'
import {
  active, ensureActive, fmtMinutes, fmtVolume, loadExercises, loadTemplate, loadWorkouts, monthLabel, startWorkout, templateNames,
  workoutMinutes, workouts, workoutsCached, workoutsError, workoutsLoading, workoutsMore, type WorkoutSummary,
} from '../../data/lift'

export function LiftHome({ startSheet }: { startSheet: boolean }) {
  useEffect(() => { void ensureActive(); void loadWorkouts(); void loadExercises() }, [])
  const running = runningWorkout()
  const list = workouts.value
  const sync = syncState.value

  return (
    <>
      <TopBar title="Lift" sub={workoutsCached.value ? undefined : list.length ? `${list.length} workouts` : undefined} onRefresh={() => { void loadWorkouts(); void loadExercises() }} />
      <main class="content fade">
        {(sync === 'no-token' || sync === 'unauthorized') && (
          <div class="banner banner-danger">
            <span class="grow"><strong>{sync === 'no-token' ? 'No app token yet.' : 'The app token was rejected.'}</strong> Paste it in Settings to sync workouts.</span>
            <button type="button" class="btn btn-sm" onClick={() => navigate('#/settings')}>Settings</button>
          </div>
        )}
        {running && <ResumeBanner w={running} />}
        <section class="card" aria-label="Start a workout">
          <div class="card-head">
            <span class="card-title">Start</span>
            <span class="small faint">tap a template</span>
          </div>
          <TemplateChips running={running} />
        </section>
        <HistoryCard list={list} running={running} />
        {workoutsError.value && !list.length && (
          <div class="banner banner-danger">
            <span class="grow"><strong>Can't reach the server.</strong> {workoutsError.value}</span>
            <button type="button" class="btn btn-sm" onClick={() => void loadWorkouts()}>Retry</button>
          </div>
        )}
      </main>
      {startSheet && (
        <Sheet title="Start workout" sub={running ? 'A workout is already running.' : 'Pick a template or start empty.'} onClose={() => navigate('#/lift')}>
          {running ? (
            <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => navigate(`#/lift/w/${running.id}`)}>
              Resume {running.name ?? 'workout'} · {elapsedLabel(running.started_at, now.value)}
            </button>
          ) : (
            <TemplateChips running={null} big />
          )}
        </Sheet>
      )}
    </>
  )
}

/** The workout in progress: what the server said (Today payload) or what we started locally. */
export function runningWorkout(): Workout | null {
  const a = active.value
  if (a && !a.workout.ended_at && !a.workout.deleted_at) return a.workout
  const w = today.value?.running.workout ?? null
  return w && !w.ended_at && !w.deleted_at ? w : null
}

function ResumeBanner({ w }: { w: Workout }) {
  return (
    <a class="resume" href={`#/lift/w/${w.id}`} aria-label="Resume the running workout">
      <span class="badge badge-workout">running</span>
      <span class="grow">
        <b>{w.name ?? 'Workout'}</b>
        <span class="small">started {elapsedLabel(w.started_at, now.value)} ago · tap to resume</span>
      </span>
      <Icon name="chevron" size={18} />
    </a>
  )
}

export function TemplateChips({ running, big = false }: { running: Workout | null; big?: boolean }) {
  const names = templateNames(workouts.value)
  const [busy, setBusy] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')

  const start = async (name: string | null) => {
    if (running) { toast('Finish the running workout first'); navigate(`#/lift/w/${running.id}`); return }
    const key = name ?? ''
    if (busy !== null) return
    setBusy(key)
    try {
      const template = name ? await loadTemplate(name).catch(() => null) : null
      const w = await startWorkout(name, template)
      const n = template ? template.exercises.length : 0
      toast(n ? `${w.name} · ${n} exercise${n === 1 ? '' : 's'} from last time` : `${w.name ?? 'Workout'} started`)
      navigate(`#/lift/w/${w.id}`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not start', { kind: 'danger' })
    } finally {
      setBusy(null)
    }
  }
  const cls = big ? 'tpl-chip btn-big' : 'tpl-chip'
  return (
    <>
      <div class="tpl-chips">
        {names.map((n) => (
          <button key={n} type="button" class={cls} onClick={() => void start(n)} disabled={busy !== null} aria-busy={busy === n}>
            <Icon name="lift" size={16} /> {n}
          </button>
        ))}
        <button type="button" class={`${cls} tpl-empty`} onClick={() => void start(null)} disabled={busy !== null}>
          <Icon name="plus" size={16} /> Empty
        </button>
        <button type="button" class={`${cls} tpl-empty`} onClick={() => { setDraft(''); setNaming(true) }} disabled={busy !== null}>
          <Icon name="edit" size={16} /> Named…
        </button>
      </div>
      {names.length === 0 && <p class="small faint" style={{ marginTop: '10px' }}>Templates appear here once you finish a named workout (Push, Pull, Legs…).</p>}
      {naming && (
        <Sheet title="Name this workout" sub="Push, Pull, Legs, Upper… the name becomes a template chip next time." onClose={() => setNaming(false)}>
          <form class="stack" onSubmit={(e) => { e.preventDefault(); setNaming(false); void start(draft.trim() || null) }}>
            <input type="text" value={draft} onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)} placeholder="Push" autocapitalize="words" autocomplete="off" aria-label="Workout name" />
            <button type="submit" class="btn btn-primary btn-big btn-block"><Icon name="check" size={20} /> Start</button>
          </form>
        </Sheet>
      )}
    </>
  )
}

function HistoryCard({ list, running }: { list: WorkoutSummary[]; running: Workout | null }) {
  const unit = settings.value.weight_unit
  const at = now.value
  const groups: { key: string; rows: WorkoutSummary[] }[] = []
  for (const w of list) {
    const key = w.local_day.slice(0, 7)
    const g = groups[groups.length - 1]
    if (g && g.key === key) g.rows.push(w)
    else groups.push({ key, rows: [w] })
  }
  return (
    <section class="card" aria-label="History">
      <div class="card-head">
        <span class="card-title">History</span>
        <a href="#/lift/exercises" class="small link-row" style={{ gap: '2px' }}>Exercises <Icon name="chevron" size={14} /></a>
      </div>
      {list.length === 0 && !workoutsLoading.value && (
        <p class="lift-empty">No workouts yet.<br />Start one above; it lands here with its sets and volume.</p>
      )}
      {list.length === 0 && workoutsLoading.value && <p class="lift-empty">Loading history…</p>}
      {groups.map((g) => (
        <div key={g.key}>
          <div class="hist-month">{monthLabel(`${g.key}-01`)}</div>
          <div class="list">
            {g.rows.map((w) => {
              const open = !w.ended_at
              const href = open && (running?.id === w.id || !running) ? `#/lift/w/${w.id}` : `#/lift/s/${w.id}`
              return (
                <a key={w.id} class="list-row list-link hist-row" href={href}>
                  <div class="grow">
                    <div class="hist-name">
                      <span>{w.name ?? 'Workout'}</span>
                      {open && <span class="badge badge-workout">running</span>}
                      {w.ended_by === 'auto' && <span class="badge badge-auto">auto-closed</span>}
                    </div>
                    <div class="hist-meta num">
                      {dayLabel(w.local_day)} · {fmtMinutes(workoutMinutes(w, at))} · {w.sets_count} set{w.sets_count === 1 ? '' : 's'} · {fmtVolume(w.volume, unit)}
                    </div>
                  </div>
                  <Icon name="chevron" size={18} />
                </a>
              )
            })}
          </div>
        </div>
      ))}
      {list.length > 0 && workoutsMore.value && (
        <button type="button" class="btn btn-ghost btn-block" style={{ marginTop: '12px' }} onClick={() => void loadWorkouts(true)} disabled={workoutsLoading.value}>
          {workoutsLoading.value ? 'Loading…' : 'Older workouts'}
        </button>
      )}
    </section>
  )
}
