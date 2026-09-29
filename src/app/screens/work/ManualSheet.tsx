// "+ Manual" (a finished session typed in by hand) and the edit sheet for an existing one: project, duration
// chips 25 / 50 / 90 or any minutes, an optional start time, the day, a note. Editing adds Delete.
import { useState } from 'preact/hooks'
import type { Project } from '@shared/types'
import { localHHMM, zonedToUTC } from '@shared/tz'
import { Sheet } from '../../components/Sheet'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { localToday, tz } from '../../data/store'
import {
  DURATION_CHIPS, activeProjects, addManualSession, deleteSession, editSession, projectById, projectColor, projects, secondsLabel, type SessionRow,
} from '../../data/work'

const HHMM = /^\d{2}:\d{2}$/

export function ManualSheet({ editing, onClose }: { editing?: SessionRow; onClose: () => void }) {
  const zone = tz.value
  const all = projects.value
  const active = activeProjects.value
  const [projectId, setProjectId] = useState(editing?.project_id ?? active[0]?.id ?? '')
  const [minutes, setMinutes] = useState(() => (editing?.duration_s ? String(Math.round(editing.duration_s / 60)) : '50'))
  const [start, setStart] = useState(editing ? localHHMM(editing.started_at, zone) : '')
  const [day, setDay] = useState(editing?.local_day ?? localToday.value)
  const [note, setNote] = useState(editing?.note ?? '')
  const [busy, setBusy] = useState(false)

  const min = Number(minutes)
  const validMin = Number.isFinite(min) && min >= 1 && min <= 1440
  const choices: Project[] = editing && !active.some((p) => p.id === editing.project_id)
    ? [...active, ...all.filter((p) => p.id === editing.project_id)]
    : active
  const project = projectById(projectId)

  const save = async (e?: Event) => {
    e?.preventDefault()
    if (!project) { toast('Pick a project', { kind: 'danger' }); return }
    if (!validMin) { toast('Duration must be 1–1440 minutes', { kind: 'danger' }); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { toast('Pick a day', { kind: 'danger' }); return }
    if (start && !HHMM.test(start)) { toast('Start time looks wrong', { kind: 'danger' }); return }
    setBusy(true)
    try {
      const startAt = start ? zonedToUTC(day, start, zone) : undefined
      if (editing) {
        const s = startAt ?? new Date(editing.started_at)
        const endAt = new Date(s.getTime() + Math.round(min) * 60_000)
        await editSession(editing, { project_id: project.id, started_at: s.toISOString(), ended_at: endAt.toISOString(), note })
        toast(`${project.name} · ${secondsLabel(Math.round(min) * 60)} updated`)
      } else {
        await addManualSession(project, { minutes: Math.round(min), start: startAt, note, day })
        toast(`${project.name} · ${secondsLabel(Math.round(min) * 60)} logged`)
      }
      onClose()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not save', { kind: 'danger' })
    } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!editing || !confirm('Delete this session?')) return
    setBusy(true)
    try {
      await deleteSession(editing)
      toast('Session deleted')
      onClose()
    } finally { setBusy(false) }
  }

  return (
    <Sheet title={editing ? 'Edit session' : 'Log a session'} sub={editing ? `${editing.project_name} · ${localHHMM(editing.started_at, zone)}` : 'Already done, not timed'} onClose={onClose}>
      <form class="stack" onSubmit={save}>
        <div class="field">
          <span class="label">Project</span>
          {choices.length === 0 ? (
            <p class="small muted">No projects yet. Add one from the Projects card first.</p>
          ) : (
            <div class="chip-scroll" role="group" aria-label="Project">
              {choices.map((p) => (
                <button key={p.id} type="button" class="chip chip-proj" aria-pressed={p.id === projectId} style={`--c:${projectColor(p)}`} onClick={() => setProjectId(p.id)}>
                  <i class="pdot" />{p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div class="field">
          <label for="man-min">Duration</label>
          <div class="dur-row">
            {DURATION_CHIPS.map((m) => (
              <button key={m} type="button" class="chip chip-dur" aria-pressed={minutes === String(m)} onClick={() => setMinutes(String(m))}>{m} min</button>
            ))}
            <input id="man-min" type="number" inputMode="numeric" min={1} max={1440} value={minutes} onInput={(e) => setMinutes((e.currentTarget as HTMLInputElement).value)} aria-label="Minutes" />
          </div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="man-start">Start <span class="faint">{editing ? '' : '(optional)'}</span></label>
            <input id="man-start" type="time" value={start} onInput={(e) => setStart((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label for="man-day">Day</label>
            <input id="man-day" class="input" type="date" value={day} max={localToday.value} onInput={(e) => setDay((e.currentTarget as HTMLInputElement).value)} />
          </div>
        </div>
        <div class="field">
          <label for="man-note">What got done? <span class="faint">(optional)</span></label>
          <textarea id="man-note" class="note" rows={2} value={note} onInput={(e) => setNote((e.currentTarget as HTMLTextAreaElement).value)} placeholder="One line is enough" />
        </div>
        <button type="submit" class="btn btn-primary btn-big btn-block" disabled={busy || !project || !validMin}>
          <Icon name="check" size={20} /> {editing ? 'Save changes' : 'Log session'}
        </button>
        {editing && (
          <button type="button" class="btn btn-danger btn-block" onClick={remove} disabled={busy}>
            <Icon name="trash" size={18} /> Delete session
          </button>
        )}
      </form>
    </Sheet>
  )
}
