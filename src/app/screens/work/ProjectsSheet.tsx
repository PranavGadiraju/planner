// Project management: add, rename, colour, kind (project | study), archive / restore. Rows expand in place.
import { useState } from 'preact/hooks'
import type { Project } from '@shared/types'
import { Sheet } from '../../components/Sheet'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { PROJECT_COLORS, addProject, archiveProject, projectColor, projects, updateProject } from '../../data/work'
import { ArchiveIcon } from './icons'

export function ProjectsSheet({ onClose }: { onClose: () => void }) {
  const list = projects.value
  const active = list.filter((p) => !p.archived_at)
  const archived = list.filter((p) => p.archived_at)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Project['kind']>('project')
  const [open, setOpen] = useState<string | null>(null)

  const add = async (e: Event) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    if (list.some((p) => p.name.trim().toLowerCase() === n.toLowerCase() && !p.archived_at)) { toast(`${n} already exists`, { kind: 'danger' }); return }
    const color = PROJECT_COLORS[active.length % PROJECT_COLORS.length] ?? null
    await addProject(n, kind, color)
    setName('')
    toast(`${n} added`)
  }

  return (
    <Sheet title="Projects" sub="Tap one to rename, recolour or archive it" onClose={onClose}>
      <div class="stack">
        <form class="stack-sm" onSubmit={add} aria-label="Add project">
          <div class="row">
            <input class="grow" type="text" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} placeholder="New project or course" enterkeyhint="done" autocomplete="off" aria-label="Name" />
            <button type="submit" class="btn btn-primary" disabled={!name.trim()}><Icon name="plus" size={18} /> Add</button>
          </div>
          <div class="seg" role="group" aria-label="Kind">
            <button type="button" aria-pressed={kind === 'project'} onClick={() => setKind('project')}>Project</button>
            <button type="button" aria-pressed={kind === 'study'} onClick={() => setKind('study')}>Study</button>
          </div>
        </form>
        {active.length === 0 && archived.length === 0 && <p class="empty-hint">Nothing here yet. Side projects, courses, a thesis: anything you want time and notes for.</p>}
        {active.length > 0 && (
          <div class="proj-list">
            {active.map((p) => <Row key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />)}
          </div>
        )}
        {archived.length > 0 && (
          <>
            <span class="section-title">Archived</span>
            <div class="proj-list">
              {archived.map((p) => <Row key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} />)}
            </div>
          </>
        )}
      </div>
    </Sheet>
  )
}

function Row({ p, open, onToggle }: { p: Project; open: boolean; onToggle: () => void }) {
  const [name, setName] = useState(p.name)
  const [busy, setBusy] = useState(false)
  const dirty = name.trim() !== p.name && name.trim() !== ''
  const save = async () => {
    setBusy(true)
    try {
      await updateProject(p, { name: name.trim() })
      toast(`Renamed to ${name.trim()}`)
    } finally { setBusy(false) }
  }
  const setColor = (c: string | null) => void updateProject(p, { color: c })
  const setKind = (k: Project['kind']) => void updateProject(p, { kind: k })
  const archive = async () => {
    setBusy(true)
    try {
      await archiveProject(p, !p.archived_at)
      toast(p.archived_at ? `${p.name} restored` : `${p.name} archived`)
      onToggle()
    } finally { setBusy(false) }
  }
  return (
    <div>
      <button type="button" class="proj-row list-link" onClick={onToggle} aria-expanded={open} aria-label={`${p.name}: ${open ? 'close' : 'edit'}`} style={{ width: '100%' }}>
        <i class="pdot" style={`--c:${projectColor(p)}`} />
        <div class="proj-main">
          <span class="proj-name"><span>{p.name}</span>{p.kind === 'study' && <span class="badge badge-study">study</span>}</span>
          {p.archived_at && <span class="proj-meta">archived</span>}
        </div>
        <Icon name={open ? 'up' : 'down'} size={18} />
      </button>
      {open && (
        <div class="stack" style={{ padding: '4px 0 14px' }}>
          <div class="row">
            <input class="grow" type="text" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} aria-label="Project name" autocomplete="off" />
            <button type="button" class="btn" onClick={save} disabled={!dirty || busy}>Rename</button>
          </div>
          <div class="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div class="seg" role="group" aria-label="Kind">
              <button type="button" aria-pressed={p.kind === 'project'} onClick={() => setKind('project')}>Project</button>
              <button type="button" aria-pressed={p.kind === 'study'} onClick={() => setKind('study')}>Study</button>
            </div>
            <button type="button" class={`btn btn-sm ${p.archived_at ? 'btn-primary' : 'btn-ghost'}`} onClick={archive} disabled={busy}>
              <ArchiveIcon size={16} /> {p.archived_at ? 'Restore' : 'Archive'}
            </button>
          </div>
          <div class="swatches" role="group" aria-label="Colour">
            <button type="button" class="swatch" style="--c:var(--cat-study)" aria-pressed={p.color === null} aria-label="Default colour" onClick={() => setColor(null)} />
            {PROJECT_COLORS.map((c) => (
              <button key={c} type="button" class="swatch" style={`--c:${c}`} aria-pressed={p.color === c} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
