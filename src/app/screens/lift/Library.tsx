// Exercise library ('#/lift/exercises'): every exercise sorted by use, search, new exercise; rows open progress.
import { useEffect, useState } from 'preact/hooks'
import { SubBar } from '../../components/TopBar'
import { Icon } from '../../components/Icon'
import { exercises, loadExercises, normName } from '../../data/lift'
import { ExerciseSheet } from './ExercisePicker'

export function ExerciseLibrary() {
  const [q, setQ] = useState('')
  const [creating, setCreating] = useState(false)
  useEffect(() => { void loadExercises() }, [])
  const key = normName(q)
  const list = exercises.value.filter((e) => !key || normName(e.name).includes(key) || (e.muscle ?? '').toLowerCase().includes(key))
  return (
    <>
      <SubBar title="Exercises" fallback="#/lift" right={<button type="button" class="icon-btn" onClick={() => setCreating(true)} aria-label="New exercise"><Icon name="plus" /></button>} />
      <main class="content fade">
        <input type="search" placeholder="Search exercises" value={q} onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} aria-label="Search exercises" autocomplete="off" />
        <section class="card" aria-label="Exercise list">
          {list.length === 0 && <p class="lift-empty">{exercises.value.length === 0 ? 'No exercises yet. They are created the first time you add one to a workout.' : 'No match.'}</p>}
          <div class="list">
            {list.map((e) => (
              <a key={e.id} class="list-row list-link" href={`#/lift/e/${e.id}`}>
                <div class="grow">
                  <div>{e.name}</div>
                  <div class="small faint">{e.muscle ? `${e.muscle} · ` : ''}{e.load_type === 'bodyweight' ? 'bodyweight · ' : ''}used {e.use_count}× · step {e.weight_step}</div>
                </div>
                <Icon name="chevron" size={18} />
              </a>
            ))}
          </div>
        </section>
        <button type="button" class="btn btn-ghost btn-block" onClick={() => setCreating(true)}><Icon name="plus" size={18} /> New exercise</button>
      </main>
      {creating && <ExerciseSheet onSaved={() => {}} onClose={() => setCreating(false)} />}
    </>
  )
}
