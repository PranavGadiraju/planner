// Exercise picker (search over existing names, most used first) with an explicit "Create <name>" so a typo never
// silently becomes a second "Bench press"; and the create / edit form sheet.
import { useState } from 'preact/hooks'
import type { Exercise } from '@shared/types'
import { Icon } from '../../components/Icon'
import { Sheet } from '../../components/Sheet'
import { toast } from '../../components/Toast'
import { createExercise, exercises, findExerciseByName, normName, updateExercise, type ExercisePatch } from '../../data/lift'
import { settings } from '../../data/store'

export function ExercisePicker({ exclude = [], allowCreate = true, autoFocus = false, onPick, placeholder = 'Search or type a new name' }: {
  exclude?: readonly string[]
  allowCreate?: boolean
  autoFocus?: boolean
  onPick: (ex: Exercise) => void
  placeholder?: string
}) {
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const key = normName(q)
  const list = exercises.value.filter((e) => !exclude.includes(e.id) && (!key || normName(e.name).includes(key) || (e.muscle ?? '').toLowerCase().includes(key)))
  const exact = findExerciseByName(exercises.value, q)
  // The picker stays mounted (it is the last pager page), so the query is cleared after every pick.
  const pick = (ex: Exercise) => { setQ(''); onPick(ex) }
  const create = async () => {
    const name = q.trim().replace(/\s+/g, ' ')
    if (!name || busy) return
    if (exact) { pick(exact); return }
    setBusy(true)
    try {
      const row = await createExercise(name)
      toast(`Created ${row.name}`)
      pick(row)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class="stack-sm">
      <input
        type="search"
        placeholder={placeholder}
        value={q}
        onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (exact) pick(exact); else if (allowCreate) void create() } }}
        autocomplete="off"
        autocapitalize="words"
        aria-label="Exercise name"
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
      />
      <div class="picker-list">
        {list.map((e) => (
          <button key={e.id} type="button" class="picker-row" onClick={() => pick(e)}>
            <span class="grow">{e.name}</span>
            <span class="faint">{e.muscle ? `${e.muscle} · ` : ''}{e.use_count}×</span>
            <Icon name="plus" size={18} />
          </button>
        ))}
        {list.length === 0 && !key && <p class="lift-empty">No exercises yet. Type a name to create the first one.</p>}
        {list.length === 0 && key && !allowCreate && <p class="lift-empty">No match.</p>}
      </div>
      {allowCreate && key && !exact && (
        <button type="button" class="btn btn-primary btn-block picker-create" onClick={create} disabled={busy}>
          <Icon name="plus" size={18} /> Create “{q.trim().replace(/\s+/g, ' ')}”
        </button>
      )}
    </div>
  )
}

/** Create (no `exercise`) or edit an exercise: name, muscle, load type, weight step. */
export function ExerciseSheet({ exercise, onSaved, onClose }: { exercise?: Exercise; onSaved: (ex: Exercise) => void; onClose: () => void }) {
  const unit = settings.value.weight_unit
  const [name, setName] = useState(exercise?.name ?? '')
  const [muscle, setMuscle] = useState(exercise?.muscle ?? '')
  const [load, setLoad] = useState<Exercise['load_type']>(exercise?.load_type ?? 'weight')
  const [step, setStep] = useState(String(exercise?.weight_step ?? (unit === 'kg' ? 2.5 : 5)))
  const [busy, setBusy] = useState(false)
  const dup = !exercise || normName(name) !== normName(exercise.name) ? findExerciseByName(exercises.value, name) : null
  const save = async () => {
    const clean = name.trim().replace(/\s+/g, ' ')
    if (!clean) { toast('Name is required', { kind: 'danger' }); return }
    if (dup && dup.id !== exercise?.id) { toast(`“${dup.name}” already exists`, { kind: 'danger' }); return }
    const stepN = Number(step)
    const patch: ExercisePatch = { name: clean, muscle: muscle.trim() || null, load_type: load, weight_step: Number.isFinite(stepN) && stepN > 0 ? stepN : undefined }
    setBusy(true)
    try {
      const row = exercise ? await updateExercise(exercise, patch) : await createExercise(clean, patch)
      toast(exercise ? 'Exercise updated' : `Created ${row.name}`)
      onSaved(row)
      onClose()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title={exercise ? 'Edit exercise' : 'New exercise'} onClose={onClose}>
      <div class="stack">
        <div class="field">
          <label for="ex-name">Name</label>
          <input id="ex-name" type="text" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} autocapitalize="words" autocomplete="off" />
          {dup && dup.id !== exercise?.id && <span class="small" style={{ color: 'var(--danger)' }}>“{dup.name}” already exists — pick it instead of creating a twin.</span>}
        </div>
        <div class="field">
          <label for="ex-muscle">Muscle <span class="faint">(optional)</span></label>
          <input id="ex-muscle" type="text" value={muscle} onInput={(e) => setMuscle((e.currentTarget as HTMLInputElement).value)} placeholder="chest, back, quads…" autocapitalize="none" autocomplete="off" />
        </div>
        <div class="grid-2">
          <div class="field">
            <span class="label">Load</span>
            <div class="seg" role="group" aria-label="Load type">
              <button type="button" aria-pressed={load === 'weight'} onClick={() => setLoad('weight')}>Weight</button>
              <button type="button" aria-pressed={load === 'bodyweight'} onClick={() => setLoad('bodyweight')}>Body</button>
            </div>
          </div>
          <div class="field">
            <label for="ex-step">Step ({unit})</label>
            <input id="ex-step" type="number" inputMode="decimal" step="0.5" min="0.5" value={step} onInput={(e) => setStep((e.currentTarget as HTMLInputElement).value)} />
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-big btn-block" onClick={save} disabled={busy}>
          <Icon name="check" size={20} /> {exercise ? 'Save' : 'Create'}
        </button>
      </div>
    </Sheet>
  )
}
