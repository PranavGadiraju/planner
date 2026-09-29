// Active workout ('#/lift/w/<id>'): name + elapsed + Finish; a horizontal pager with one page per exercise and
// "Add exercise" last; per exercise the ghost line, weight / reps steppers, the 64 px LOG SET button (re-armed by
// the pre-fill rule), the logged sets (tap = edit sheet); warm-up toggle, keep-screen-on, and the 3 h auto-close hint.
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Exercise, SetRow } from '@shared/types'
import { epley1RM } from '@shared/nutrition'
import { Icon } from '../../components/Icon'
import { Sheet } from '../../components/Sheet'
import { toast } from '../../components/Toast'
import { navigate } from '../../router'
import { dayLabel, hhmm } from '../../data/format'
import { settings, tz } from '../../data/store'
import {
  AUTO_CLOSE_MS, active, addExerciseToWorkout, autoCloseEnd, deleteSet, deleteWorkout, editSet, exercises, finishWorkout, fmtWeight, lastSessionSets,
  lastSets, loadExercises, loadTemplate, loadWorkouts, logSet, nextSetNo, openWorkout, prefillSet, priorBestFor, removeExerciseFromWorkout, renameWorkout,
  type ActiveState, type OpenResult, type TemplatePayload,
} from '../../data/lift'
import { ExercisePicker } from './ExercisePicker'
import { NumPad } from './NumPad'

const ADD = '__add'
const WAKE_KEY = 'planner.lift.wake'
const workingSets = (a: ActiveState) => a.sets.filter((s) => !s.is_warmup).length

export function ActiveWorkout({ id }: { id: string }) {
  const [state, setState] = useState<OpenResult | 'loading'>('loading')
  const [template, setTemplate] = useState<TemplatePayload | null>(null)
  const a = active.value
  const ready = a && a.workout.id === id ? a : null

  useEffect(() => {
    let alive = true
    setState('loading')
    void loadExercises()
    void openWorkout(id).then((r) => {
      if (!alive) return
      setState(r)
      if (r === 'finished') { toast('That workout is finished'); navigate(`#/lift/s/${id}`) }
    })
    return () => { alive = false }
  }, [id])
  const name = ready?.workout.name ?? null
  useEffect(() => {
    let alive = true
    setTemplate(null)
    if (name) void loadTemplate(name).then((t) => { if (alive) setTemplate(t) }, () => {})
    return () => { alive = false }
  }, [name])

  if (!ready) {
    return (
      <>
        <Bar title="Workout" elapsed="" onFinish={null} />
        <main class="content fade">
          {state === 'loading' && <div class="banner banner-info">Opening the workout…</div>}
          {state === 'missing' && <div class="banner banner-danger"><span class="grow">No such workout.</span><button type="button" class="btn btn-sm" onClick={() => navigate('#/lift')}>Back</button></div>}
          {state === 'offline' && <div class="banner banner-danger"><span class="grow">Offline and this workout is not cached on this device.</span><button type="button" class="btn btn-sm" onClick={() => navigate('#/lift')}>Back</button></div>}
        </main>
      </>
    )
  }
  return <Session a={ready} template={template} />
}

function Bar({ title, elapsed, onFinish, onRename }: { title: string; elapsed: string; onFinish: (() => void) | null; onRename?: () => void }) {
  return (
    <header class="topbar">
      <div class="topbar-row">
        <button type="button" class="icon-btn" onClick={() => navigate('#/lift')} aria-label="Back to Lift" style={{ marginLeft: '-8px' }}>
          <Icon name="back" />
        </button>
        <button type="button" class="wk-title" onClick={onRename} aria-label={`${title}, tap to rename`}>
          <h1>{title}</h1>
          {elapsed && <span class="wk-elapsed num">{elapsed}</span>}
        </button>
        {onFinish && <button type="button" class="btn btn-sm btn-primary" onClick={onFinish}>Finish</button>}
      </div>
    </header>
  )
}

function useElapsed(startIso: string): { label: string; ms: number } {
  const [t, setT] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => setT(Date.now())
    const iv = setInterval(tick, 1000)
    const onVis = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  const ms = Math.max(0, t - new Date(startIso).getTime())
  const s = Math.floor(ms / 1000)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  const h = Math.floor(s / 3600)
  const label = h > 0 ? `${h}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`
  return { label, ms }
}

function useWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    let lock: WakeLockSentinel | null = null
    let alive = true
    const acquire = async () => {
      try {
        if (document.visibilityState !== 'visible' || !navigator.wakeLock) return
        const l = await navigator.wakeLock.request('screen')
        if (!alive) { void l.release().catch(() => {}); return }
        lock = l
      } catch { /* denied or unsupported: ignore */ }
    }
    const onVis = () => { if (document.visibilityState === 'visible') void acquire() }
    void acquire()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVis)
      void lock?.release().catch(() => {})
    }
  }, [enabled])
}

function Session({ a, template }: { a: ActiveState; template: TemplatePayload | null }) {
  const w = a.workout
  const { label: elapsed, ms } = useElapsed(w.started_at)
  const unit = settings.value.weight_unit
  const pages = [...a.exercise_ids, ADD]
  const pagerRef = useRef<HTMLDivElement>(null)
  const [page, setPage] = useState(0)
  const [wake, setWake] = useState(() => { try { return localStorage.getItem(WAKE_KEY) === '1' } catch { return false } })
  const [finishing, setFinishing] = useState(false)
  const [renaming, setRenaming] = useState(false)
  useWakeLock(wake)
  const pendingJump = useRef<number | null>(null)

  const goTo = (i: number) => {
    const el = pagerRef.current
    if (!el) return
    el.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' })
  }
  const onScroll = () => {
    const el = pagerRef.current
    if (!el || el.clientWidth === 0) return
    const p = Math.round(el.scrollLeft / el.clientWidth)
    if (p !== page) setPage(p)
  }
  // After an exercise is added, slide to its new page once it exists.
  useEffect(() => {
    if (pendingJump.current !== null && pendingJump.current < pages.length) { goTo(pendingJump.current); pendingJump.current = null }
  }, [pages.length])

  const add = (ex: Exercise) => {
    const idx = a.exercise_ids.indexOf(ex.id)
    if (idx >= 0) { goTo(idx); return }
    pendingJump.current = a.exercise_ids.length
    addExerciseToWorkout(ex.id)
  }
  const finish = async (endedAt?: string) => {
    const r = await finishWorkout(w, endedAt)
    toast(r.line, { duration: 5000 })
    setFinishing(false)
    navigate('#/lift')
    void loadWorkouts()
  }
  const discard = async () => {
    await deleteWorkout(w)
    toast('Workout discarded')
    setFinishing(false)
    navigate('#/lift')
  }
  const onFinishTap = () => { if (a.sets.length === 0) setFinishing(true); else void finish() }
  const overdue = ms > AUTO_CLOSE_MS
  const toggleWake = () => { const v = !wake; setWake(v); try { localStorage.setItem(WAKE_KEY, v ? '1' : '0') } catch { /* ignore */ } }

  return (
    <>
      <Bar title={w.name ?? 'Workout'} elapsed={elapsed} onFinish={onFinishTap} onRename={() => setRenaming(true)} />
      <main class="content fade wk-content">
        {overdue && (
          <div class="banner">
            <span class="grow small"><strong>Open for over 3 h.</strong> Forgotten? Close it 2 min after the last set{a.sets.length ? ` (${hhmm(autoCloseEnd(w, a.sets), tz.value)})` : ''}; the nightly job would auto-close it anyway.</span>
            <button type="button" class="btn btn-sm" onClick={() => void finish(autoCloseEnd(w, a.sets))}>Close</button>
          </div>
        )}
        <div class="pager" ref={pagerRef} onScroll={onScroll}>
          {a.exercise_ids.map((eid) => (
            <div class="page" key={eid}>
              <ExercisePage a={a} exerciseId={eid} template={template} unit={unit} />
            </div>
          ))}
          <div class="page" key={ADD}>
            <section class="card" aria-label="Add exercise">
              <div class="card-head"><span class="card-title">Add exercise</span><span class="small faint">{a.exercise_ids.length} in this workout</span></div>
              <ExercisePicker exclude={a.exercise_ids} onPick={add} />
            </section>
          </div>
        </div>
        <div class="pager-nav">
          <button type="button" class="icon-btn" onClick={() => goTo(page - 1)} disabled={page <= 0} aria-label="Previous exercise"><Icon name="back" /></button>
          <div class="dots" aria-label={`Page ${page + 1} of ${pages.length}`}>
            {pages.map((p, i) => <i key={p} data-on={i === page} data-add={p === ADD} />)}
          </div>
          <button type="button" class="icon-btn" onClick={() => goTo(page + 1)} disabled={page >= pages.length - 1} aria-label="Next exercise"><Icon name="chevron" /></button>
        </div>
        <div class="wk-foot">
          <button type="button" class="warm-toggle" role="switch" aria-checked={wake} onClick={toggleWake}>
            <span class="switch" aria-checked={wake} aria-hidden="true" /> Keep screen on
          </button>
          <span class="small faint num">{workingSets(a)} set{workingSets(a) === 1 ? '' : 's'} · started {hhmm(w.started_at, tz.value)}</span>
        </div>
      </main>
      {finishing && (
        <Sheet title="Nothing logged yet" sub="Finish an empty workout, or discard it so it never shows in history." onClose={() => setFinishing(false)}>
          <div class="stack-sm">
            <button type="button" class="btn btn-danger btn-big btn-block" onClick={() => void discard()}><Icon name="trash" size={18} /> Discard workout</button>
            <button type="button" class="btn btn-ghost btn-block" onClick={() => void finish()}>Finish anyway</button>
          </div>
        </Sheet>
      )}
      {renaming && <RenameSheet a={a} onClose={() => setRenaming(false)} />}
    </>
  )
}

function RenameSheet({ a, onClose }: { a: ActiveState; onClose: () => void }) {
  const [draft, setDraft] = useState(a.workout.name ?? '')
  const save = async (e: Event) => {
    e.preventDefault()
    await renameWorkout(a.workout, draft)
    onClose()
  }
  return (
    <Sheet title="Workout name" sub="The name is the template chip next time." onClose={onClose}>
      <form class="stack" onSubmit={(e) => void save(e)}>
        <input type="text" value={draft} onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)} placeholder="Push" autocapitalize="words" autocomplete="off" aria-label="Workout name" />
        <button type="submit" class="btn btn-primary btn-big btn-block"><Icon name="check" size={20} /> Save</button>
      </form>
    </Sheet>
  )
}

function ExercisePage({ a, exerciseId, template, unit }: { a: ActiveState; exerciseId: string; template: TemplatePayload | null; unit: string }) {
  const ex = exercises.value.find((e) => e.id === exerciseId) ?? template?.exercises.find((e) => e.id === exerciseId) ?? null
  const step = ex?.weight_step && ex.weight_step > 0 ? ex.weight_step : 5
  const mySets = a.sets.filter((s) => s.exercise_id === exerciseId)
  const setNo = nextSetNo(a.sets, a.workout.id, exerciseId)
  const last = lastSets.value[exerciseId]
  const templateSets = template?.sets.filter((s) => s.exercise_id === exerciseId) ?? []
  const ghost = lastSessionSets(last, a.workout.id) ?? (templateSets.length && template?.workout ? { day: template.workout.local_day, sets: templateSets } : null)
  const best = priorBestFor(a, exerciseId, new Date().toISOString())

  const [reps, setReps] = useState(8)
  const [weight, setWeight] = useState(0)
  const [warm, setWarm] = useState(false)
  const [pad, setPad] = useState<'weight' | 'reps' | null>(null)
  const [editing, setEditing] = useState<SetRow | null>(null)
  const touched = useRef<number | null>(null)
  const lastLoaded = !!last
  // Re-arm for set N from the pre-fill rule, unless the user already adjusted the steppers for this set.
  useEffect(() => {
    if (touched.current === setNo) return
    const p = prefillSet(setNo, { templateSets, currentSets: mySets, lastEver: last?.sets ?? [] })
    setReps(p.reps)
    setWeight(p.weight)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setNo, exerciseId, template, lastLoaded])

  const touch = () => { touched.current = setNo }
  const bump = (kind: 'weight' | 'reps', dir: 1 | -1) => {
    touch()
    if (kind === 'weight') setWeight((v) => Math.max(0, Math.round((v + dir * step) * 100) / 100))
    else setReps((v) => Math.max(1, v + dir))
  }
  const log = async () => {
    try {
      const r = await logSet(exerciseId, reps, weight, warm)
      touched.current = null
      setWarm(false)
      if (r.pr) toast(`PR · e1RM ${Math.round(epley1RM(r.set.weight, r.set.reps))} ${unit}`)
      try { navigator.vibrate?.(12) } catch { /* ignore */ }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not log the set', { kind: 'danger' })
    }
  }

  return (
    <section class="card stack-sm" aria-label={ex?.name ?? 'Exercise'}>
      <div class="ex-head">
        <div class="grow">
          <a class="ex-name" href={`#/lift/e/${exerciseId}`} style={{ fontWeight: 700 }}>{ex?.name ?? 'Exercise'} <Icon name="chevron" size={16} /></a>
          {ex?.muscle && <div class="ex-muscle">{ex.muscle}</div>}
          <div class="ghost num">
            <div>{ghost ? <>Last ({dayLabel(ghost.day).slice(4)}): <b>{ghost.sets.map((s) => `${fmtWeight(s.weight)}×${s.reps}`).join(', ')}</b></> : 'First time logging this one.'}</div>
            {best !== null && <div class="pr">Best e1RM {Math.round(best)} {unit}</div>}
          </div>
        </div>
        {mySets.length === 0 && (
          <button type="button" class="icon-btn" onClick={() => removeExerciseFromWorkout(exerciseId)} aria-label="Remove exercise from this workout"><Icon name="x" size={18} /></button>
        )}
      </div>

      <div class="steppers">
        <div class="stepper" aria-label="Weight">
          <button type="button" class="stepper-btn" onClick={() => bump('weight', -1)} aria-label={`Weight minus ${step}`}><Icon name="down" size={22} /></button>
          <button type="button" class="stepper-val" onClick={() => setPad('weight')} aria-label={`Weight ${fmtWeight(weight)} ${unit}, tap to type`}>
            <b>{fmtWeight(weight)}</b><span>{ex?.load_type === 'bodyweight' ? `+ ${unit}` : unit}</span>
          </button>
          <button type="button" class="stepper-btn" onClick={() => bump('weight', 1)} aria-label={`Weight plus ${step}`}><Icon name="up" size={22} /></button>
        </div>
        <div class="stepper" aria-label="Reps">
          <button type="button" class="stepper-btn" onClick={() => bump('reps', -1)} aria-label="One rep fewer"><Icon name="down" size={22} /></button>
          <button type="button" class="stepper-val" onClick={() => setPad('reps')} aria-label={`${reps} reps, tap to type`}>
            <b>{reps}</b><span>reps</span>
          </button>
          <button type="button" class="stepper-btn" onClick={() => bump('reps', 1)} aria-label="One rep more"><Icon name="up" size={22} /></button>
        </div>
      </div>

      <button type="button" class="log-btn" data-warm={warm} onClick={() => void log()}>
        <Icon name="check" size={22} stroke={2.5} /> {warm ? `Log warm-up ${setNo}` : `Log set ${setNo}`}
      </button>
      <div class="ex-tools">
        <button type="button" class="warm-toggle" role="switch" aria-checked={warm} onClick={() => setWarm(!warm)}>
          <span class="switch" aria-checked={warm} aria-hidden="true" /> Warm-up
        </button>
        <span class="small faint num">{fmtWeight(weight)} × {reps} → e1RM {Math.round(epley1RM(weight, reps))}</span>
      </div>

      {mySets.length > 0 && (
        <div class="set-list" aria-label="Logged sets">
          {mySets.map((s) => (
            <button key={s.id} type="button" class="set-row" data-warm={s.is_warmup === 1} onClick={() => setEditing(s)}>
              <span class="set-no">{s.set_no}</span>
              <span class="set-val">{fmtWeight(s.weight)}<span class="dim">×</span>{s.reps}</span>
              {s.is_warmup === 1 && <span class="badge badge-warm">warm-up</span>}
              {a.pr_ids.includes(s.id) && <span class="badge badge-pr">PR</span>}
              <span class="set-time">{hhmm(s.ts, tz.value)}</span>
            </button>
          ))}
        </div>
      )}

      {pad === 'weight' && <NumPad title="Weight" unit={unit} value={weight} decimals onDone={(v) => { touch(); setWeight(v) }} onClose={() => setPad(null)} />}
      {pad === 'reps' && <NumPad title="Reps" unit="reps" value={reps} decimals={false} onDone={(v) => { touch(); setReps(Math.max(1, Math.round(v))) }} onClose={() => setPad(null)} />}
      {editing && <SetSheet s={editing} unit={unit} onClose={() => setEditing(null)} />}
    </section>
  )
}

function SetSheet({ s, unit, onClose }: { s: SetRow; unit: string; onClose: () => void }) {
  const [reps, setReps] = useState(String(s.reps))
  const [weight, setWeight] = useState(String(s.weight))
  const [warm, setWarm] = useState(s.is_warmup === 1)
  const save = async () => {
    const r = Number(reps)
    const wt = Number(weight)
    if (!Number.isInteger(r) || r < 1) { toast('Reps must be a whole number', { kind: 'danger' }); return }
    if (!Number.isFinite(wt) || wt < 0) { toast('Weight must be a number', { kind: 'danger' }); return }
    await editSet(s, { reps: r, weight: wt, is_warmup: warm })
    toast(`Set ${s.set_no} updated`)
    onClose()
  }
  const remove = async () => {
    await deleteSet(s)
    toast(`Set ${s.set_no} deleted`)
    onClose()
  }
  return (
    <Sheet title={`Set ${s.set_no}`} sub={`Logged ${hhmm(s.ts, tz.value)}`} onClose={onClose}>
      <div class="stack">
        <div class="grid-2">
          <div class="field">
            <label for="set-weight">Weight ({unit})</label>
            <input id="set-weight" type="number" inputMode="decimal" step="any" min="0" value={weight} onInput={(e) => setWeight((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label for="set-reps">Reps</label>
            <input id="set-reps" type="number" inputMode="numeric" step="1" min="1" value={reps} onInput={(e) => setReps((e.currentTarget as HTMLInputElement).value)} />
          </div>
        </div>
        <button type="button" class="warm-toggle" role="switch" aria-checked={warm} onClick={() => setWarm(!warm)}>
          <span class="switch" aria-checked={warm} aria-hidden="true" /> Warm-up (not counted for PRs or volume)
        </button>
        <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => void save()}><Icon name="check" size={20} /> Save</button>
        <button type="button" class="btn btn-danger btn-block" onClick={() => void remove()}><Icon name="trash" size={18} /> Delete set</button>
      </div>
    </Sheet>
  )
}
