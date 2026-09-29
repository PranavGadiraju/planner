// End sheet: one auto-focused "What got done?" line, an editable duration, the project chip, Save or Discard.
// Used from the Work tab's running banner and from Today's running strip.
import { useEffect, useRef, useState } from 'preact/hooks'
import '../../styles/work.css'
import { Sheet } from '../../components/Sheet'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { hhmm } from '../../data/format'
import { tz } from '../../data/store'
import {
  activeProjects, deleteSession, elapsedSeconds, endSession, loadProjects, projectById, projectColor, projects, secondsLabel,
  type SessionRow,
} from '../../data/work'

export function EndSheet({ session, onClose }: { session: SessionRow; onClose: () => void }) {
  const [note, setNote] = useState('')
  const [minutes, setMinutes] = useState(() => String(Math.max(1, Math.round(elapsedSeconds(session.started_at, new Date()) / 60))))
  const [projectId, setProjectId] = useState(session.project_id)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { const t = setTimeout(() => input.current?.focus(), 60); return () => clearTimeout(t) }, [])
  // Opened from Today the project list may not be loaded yet; it is needed for the project chips.
  useEffect(() => { if (projects.value.length === 0) void loadProjects() }, [])

  const choices = activeProjects.value
  const current = projectById(projectId)
  const min = Number(minutes)
  const valid = Number.isFinite(min) && min >= 1 && min <= 24 * 60
  const endAt = valid ? new Date(new Date(session.started_at).getTime() + Math.round(min) * 60_000) : null

  const save = async (e?: Event) => {
    e?.preventDefault()
    if (!endAt) { toast('Duration must be 1–1440 minutes', { kind: 'danger' }); return }
    setBusy(true)
    try {
      // One row: a project change rides in the end row, so the server can never keep the edit and drop the end.
      await endSession(session, note, endAt, projectId !== session.project_id ? { project_id: projectId } : {})
      toast(`${current?.name ?? session.project_name} · ${secondsLabel(Math.round(min) * 60)}${note.trim() ? ' · noted' : ''}`)
      onClose()
    } finally { setBusy(false) }
  }
  const discard = async () => {
    if (!confirm('Discard this session? Nothing will be logged.')) return
    setBusy(true)
    try {
      await deleteSession(session)
      toast('Session discarded')
      onClose()
    } finally { setBusy(false) }
  }

  return (
    <Sheet title="End session" sub={`${session.project_name} · since ${hhmm(session.started_at, tz.value)}`} onClose={onClose}>
      <form class="stack" onSubmit={save}>
        <div class="field">
          <label for="end-note">What got done?</label>
          <input
            id="end-note"
            ref={input}
            type="text"
            value={note}
            onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)}
            placeholder="e.g. built the sync layer"
            enterkeyhint="done"
            autocomplete="off"
            autofocus
          />
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="end-min">Duration (min)</label>
            <input id="end-min" type="number" inputMode="numeric" min={1} max={1440} value={minutes} onInput={(e) => setMinutes((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <span class="label">Ends</span>
            <span class="input num" style={{ display: 'flex', alignItems: 'center', color: 'var(--text-2)' }}>{endAt ? hhmm(endAt.toISOString(), tz.value) : '—'}</span>
          </div>
        </div>
        {choices.length > 1 && (
          <div class="field">
            <span class="label">Project</span>
            <div class="chip-scroll" role="group" aria-label="Project">
              {choices.map((p) => (
                <button key={p.id} type="button" class="chip chip-proj" aria-pressed={p.id === projectId} style={`--c:${projectColor(p)}`} onClick={() => setProjectId(p.id)}>
                  <i class="pdot" />{p.name}
                </button>
              ))}
            </div>
          </div>
        )}
        <button type="submit" class="btn btn-primary btn-big btn-block" disabled={busy || !valid}>
          <Icon name="check" size={20} /> Save session
        </button>
        <button type="button" class="btn btn-danger btn-block" onClick={discard} disabled={busy}>
          <Icon name="trash" size={18} /> Discard
        </button>
      </form>
    </Sheet>
  )
}
