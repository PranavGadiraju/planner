// Mac-derived session suggestions: "Log 09:10–10:40 as planner?". <SuggestionCard /> is Today's compact card (at
// most two of today's suggestions, hidden when there are none). <SuggestionItem /> is the row it and the Work tab's
// Suggested section share: times · length · top apps, a project chip (default: the project of the most recent
// session; tap to change), Log and Dismiss, and on the Work tab an Edit-times toggle (start / end / note) before
// logging.
import { useEffect, useId, useState } from 'preact/hooks'
import '../styles/work.css'
import { Icon } from './Icon'
import { toast } from './Toast'
import { durationLabel, hhmm } from '../data/format'
import { localToday, tz } from '../data/store'
import { projectColor, projects as workProjects, secondsLabel } from '../data/work'
import {
  TODAY_MAX, acceptSuggestion, appsLabel, dismissSuggestion, editedSpan, spanLabel, suggestState, suggestionKey, visibleSuggestions, watchSuggestions,
  type AcceptSpan, type SuggestProject, type Suggestion, type SuggestionsPayload,
} from '../data/suggest'

export function SuggestionCard() {
  const day = localToday.value
  useEffect(() => watchSuggestions([day]), [day])
  const data = suggestState(day).value.data
  const list = visibleSuggestions(day).slice(0, TODAY_MAX)
  if (!data || list.length === 0) return null
  return (
    <section class="card sg-card" aria-label="Suggested sessions">
      <div class="card-head">
        <span class="card-title">Suggested</span>
        <span class="small faint">Mac time outside any session</span>
      </div>
      <div class="sg-list">
        {list.map((s) => <SuggestionItem key={suggestionKey(s)} s={s} day={day} payload={data} />)}
      </div>
    </section>
  )
}

/** Live projects to pick from: the payload's list, minus archived ones the Work tab knows, plus ones queued locally. */
export function pickableProjects(payload: SuggestionsPayload, loaded: readonly { id: string; name: string; color: string | null; archived_at: string | null; deleted_at: string | null }[]): SuggestProject[] {
  const byId = new Map(payload.projects.map((p) => [p.id, p]))
  for (const p of loaded) {
    if (p.deleted_at || (p.archived_at && p.id !== payload.last_project_id)) byId.delete(p.id)
    else if (!byId.has(p.id)) byId.set(p.id, { id: p.id, name: p.name, color: p.color })
  }
  return [...byId.values()]
}

export function SuggestionItem({ s, day, payload, editable = false }: { s: Suggestion; day: string; payload: SuggestionsPayload; editable?: boolean }) {
  const zone = tz.value
  const uid = useId()
  const choices = pickableProjects(payload, workProjects.value)
  const [projectId, setProjectId] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [editing, setEditing] = useState(false)
  const [start, setStart] = useState(() => hhmm(s.start, zone))
  const [end, setEnd] = useState(() => hhmm(s.end, zone))
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const chosen = projectId ?? payload.last_project_id
  const project = choices.find((p) => p.id === chosen) ?? choices[0]
  const apps = appsLabel(s)

  const log = async () => {
    if (!project) { toast('Add a project in Work first', { kind: 'danger' }); return }
    let span: AcceptSpan | undefined
    if (editing) {
      const e = editedSpan(day, start, end, zone)
      if (!e) { toast('Start and end must be HH:MM', { kind: 'danger' }); return }
      span = e
    }
    setBusy(true)
    try {
      const row = await acceptSuggestion(s, project.id, note, span)
      toast(`${project.name} · ${secondsLabel(row.duration_s ?? 0)} logged`)
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not log', { kind: 'danger' })
    } finally { setBusy(false) }
  }
  const dismiss = () => {
    dismissSuggestion(s)
    toast('Suggestion dismissed')
  }

  return (
    <div class="sg-row">
      <div class="sg-head">
        <span class="sg-time num">{spanLabel(s, zone)}</span>
        <span class="sg-dur num">{durationLabel(s.minutes)}</span>
        <span class="sg-apps" title={apps}>{apps || 'Mac time'}</span>
      </div>
      <div class="sg-actions">
        <button
          type="button"
          class="chip chip-proj sg-proj"
          style={`--c:${projectColor(project)}`}
          aria-expanded={picking}
          aria-label={project ? `Project ${project.name}, tap to change` : 'No project yet'}
          onClick={() => setPicking(!picking)}
          disabled={busy || choices.length < 2}
        >
          <i class="pdot" /><span>{project?.name ?? 'No project'}</span>{choices.length > 1 && <Icon name="down" size={14} />}
        </button>
        <span class="grow" />
        {editable && (
          <button type="button" class={`icon-btn sg-edit-btn${editing ? ' on' : ''}`} aria-label="Edit times" aria-pressed={editing} onClick={() => setEditing(!editing)} disabled={busy}>
            <Icon name="edit" size={18} />
          </button>
        )}
        <button type="button" class="btn btn-sm btn-primary" onClick={() => void log()} disabled={busy || !project}>Log</button>
        <button type="button" class="btn btn-sm" style={{ minHeight: 44 }} onClick={dismiss} disabled={busy}>Dismiss</button>
      </div>
      {picking && choices.length > 1 && (
        <div class="chip-scroll" role="group" aria-label="Project">
          {choices.map((p) => (
            <button key={p.id} type="button" class="chip chip-proj" aria-pressed={p.id === project?.id} style={`--c:${projectColor(p)}`} onClick={() => { setProjectId(p.id); setPicking(false) }}>
              <i class="pdot" />{p.name}
            </button>
          ))}
        </div>
      )}
      {editable && editing && (
        <div class="sg-edit">
          <div class="field">
            <label for={`${uid}-start`}>Start</label>
            <input id={`${uid}-start`} type="time" value={start} onInput={(e) => setStart((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label for={`${uid}-end`}>End</label>
            <input id={`${uid}-end`} type="time" value={end} onInput={(e) => setEnd((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="field sg-note">
            <label for={`${uid}-note`}>What got done? <span class="faint">(optional)</span></label>
            <input id={`${uid}-note`} type="text" value={note} onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)} placeholder="One line is enough" autocomplete="off" />
          </div>
        </div>
      )}
    </div>
  )
}
