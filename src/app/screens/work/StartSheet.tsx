// Project picker to start a session right away ('#/work/start' from Today's quick action). Starting while another
// session runs switches to the "End <other> first?" panel with its note line inline.
import { useState } from 'preact/hooks'
import type { Project } from '@shared/types'
import { Sheet } from '../../components/Sheet'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { activeProjects, addProject, endSession, projectColor, running, startSession, type SessionRow } from '../../data/work'
import { PlayIcon } from './icons'
import { SwitchSheet } from './RunningBanner'

/** Start `project`, ending `cur` first with `note` when one is running. Returns the toast text. */
export async function startFlow(project: Project, cur: SessionRow | null, note = ''): Promise<string> {
  if (cur) await endSession(cur, note)
  const r = await startSession(project)
  if (!r.ok) return `${r.running.project_name} is still running`
  return cur ? `${cur.project_name} ended · ${project.name} started` : `${project.name} started`
}

export function StartSheet({ onClose }: { onClose: () => void }) {
  const [target, setTarget] = useState<Project | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const cur = running.value
  const list = activeProjects.value

  const go = async (p: Project, note = '') => {
    setBusy(true)
    try {
      toast(await startFlow(p, cur, note))
      onClose()
    } finally { setBusy(false) }
  }
  const pick = (p: Project) => { if (cur) setTarget(p); else void go(p) }
  const create = async (e: Event) => {
    e.preventDefault()
    if (!name.trim()) return
    const p = await addProject(name)
    setName('')
    pick(p)
  }

  if (cur && target) {
    return <SwitchSheet running={cur} targetName={target.name} onConfirm={(note) => go(target, note)} onClose={() => setTarget(null)} />
  }
  return (
    <Sheet title="Start a session" sub={cur ? `${cur.project_name} is running · pick the next one` : 'Pick a project'} onClose={onClose}>
      <div class="stack">
        {list.length > 0 && (
          <div class="proj-list">
            {list.map((p) => (
              <div key={p.id} class="proj-row">
                <i class="pdot" style={`--c:${projectColor(p)}`} />
                <div class="proj-main">
                  <span class="proj-name"><span>{p.name}</span></span>
                  {p.kind === 'study' && <span class="proj-meta">study</span>}
                </div>
                <button type="button" class="btn btn-start" onClick={() => pick(p)} disabled={busy || cur?.project_id === p.id} aria-label={`Start ${p.name}`}>
                  <PlayIcon size={16} /> {cur?.project_id === p.id ? 'Running' : 'Start'}
                </button>
              </div>
            ))}
          </div>
        )}
        <form class="row" onSubmit={create}>
          <input class="grow" type="text" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} placeholder={list.length ? 'New project…' : 'Name your first project'} enterkeyhint="go" autocomplete="off" aria-label="New project name" />
          <button type="submit" class="btn btn-primary" disabled={!name.trim() || busy}><Icon name="plus" size={18} /> Start</button>
        </form>
      </div>
    </Sheet>
  )
}
