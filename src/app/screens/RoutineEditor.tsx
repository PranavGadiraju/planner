// Routine items: reorder, rename, default minutes, chart category, active toggle, add. Saved through /api/write.
import { useEffect, useState } from 'preact/hooks'
import type { RoutineItem } from '@shared/types'
import { SubBar } from '../components/TopBar'
import { Icon, routineIconName } from '../components/Icon'
import { toast } from '../components/Toast'
import { allRoutineItems, loadRoutineItemsCache, saveRoutineItems } from '../data/store'

const RESERVED = new Set(['bed', 'wake', 'winddown'])
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/

export function RoutineEditor() {
  const [rows, setRows] = useState<RoutineItem[]>(() => allRoutineItems.value)
  const [dirty, setDirty] = useState(false)
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void loadRoutineItemsCache()
  }, [])
  useEffect(() => {
    if (!dirty) setRows(allRoutineItems.value)
  }, [allRoutineItems.value, dirty])

  const update = (id: string, patch: Partial<RoutineItem>) => {
    setRows((r) => r.map((x) => (x.id === id ? { ...x, ...patch } : x)))
    setDirty(true)
  }
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir
    if (j < 0 || j >= rows.length) return
    const next = rows.slice()
    const a = next[idx], b = next[j]
    if (!a || !b) return
    next[idx] = b
    next[j] = a
    setRows(next.map((x, i) => ({ ...x, position: i + 1 })))
    setDirty(true)
  }
  const add = () => {
    const id = slug.trim().toLowerCase()
    if (!SLUG.test(id)) { toast('Slug: lowercase letters, digits and dashes', { kind: 'danger' }); return }
    if (RESERVED.has(id)) { toast(`"${id}" is reserved`, { kind: 'danger' }); return }
    if (rows.some((r) => r.id === id)) { toast('That slug already exists', { kind: 'danger' }); return }
    if (!name.trim()) { toast('Give it a name', { kind: 'danger' }); return }
    const item: RoutineItem = {
      id, name: name.trim(), icon: null, position: rows.length + 1, default_min: 10, chart_category: 'routine', active: 1,
      updated_at: new Date().toISOString(), deleted_at: null,
    }
    setRows([...rows, item])
    setSlug('')
    setName('')
    setDirty(true)
  }
  const save = async () => {
    setBusy(true)
    try {
      const normalised = rows.map((r, i) => ({ ...r, position: i + 1, name: r.name.trim() || r.id, default_min: Math.max(1, Math.round(r.default_min) || 10) }))
      await saveRoutineItems(normalised)
      setDirty(false)
      toast('Routine saved')
    } finally { setBusy(false) }
  }

  return (
    <>
      <SubBar
        title="Routine items"
        fallback="#/settings"
        right={<button type="button" class="btn btn-sm btn-primary" onClick={save} disabled={!dirty || busy}>Save</button>}
      />
      <main class="content no-tabs fade">
        <p class="small muted" style={{ padding: '0 4px' }}>The slug is what a sticker sends to <span class="mono">/api/tap</span>; it cannot change after creation. Order here is the order on Today.</p>
        {rows.map((r, idx) => (
          <section class="card" key={r.id} style={{ opacity: r.active ? 1 : 0.6 }}>
            <div class="row" style={{ marginBottom: '10px' }}>
              <span class="badge badge-routine mono">{r.id}</span>
              <span class="grow" />
              <Icon name={routineIconName(r.icon, r.id)} size={20} class="faint" />
              <button type="button" class="icon-btn" style={{ width: 40, height: 40 }} onClick={() => move(idx, -1)} disabled={idx === 0} aria-label="Move up"><Icon name="up" size={18} /></button>
              <button type="button" class="icon-btn" style={{ width: 40, height: 40 }} onClick={() => move(idx, 1)} disabled={idx === rows.length - 1} aria-label="Move down"><Icon name="down" size={18} /></button>
            </div>
            <div class="stack-sm">
              <div class="row">
                <input class="grow" type="text" value={r.name} onInput={(e) => update(r.id, { name: (e.currentTarget as HTMLInputElement).value })} aria-label="Name" placeholder="Name" />
                <input type="number" inputMode="numeric" min={1} max={600} value={String(r.default_min)} style={{ width: 84 }} onInput={(e) => update(r.id, { default_min: Number((e.currentTarget as HTMLInputElement).value) })} aria-label="Default minutes" />
                <span class="small faint">min</span>
              </div>
              <div class="row">
                <div class="seg" role="group" aria-label="Chart category">
                  <button type="button" aria-pressed={r.chart_category === 'routine'} onClick={() => update(r.id, { chart_category: 'routine' })}>routine</button>
                  <button type="button" aria-pressed={r.chart_category === 'workout'} onClick={() => update(r.id, { chart_category: 'workout' })}>workout</button>
                </div>
                <span class="grow" />
                <span class="small muted">{r.active ? 'Active' : 'Hidden'}</span>
                <button type="button" role="switch" class="switch" aria-checked={r.active ? 'true' : 'false'} aria-label="Active" onClick={() => update(r.id, { active: r.active ? 0 : 1 })} />
              </div>
            </div>
          </section>
        ))}

        <section class="card">
          <div class="card-head"><span class="card-title">Add item</span></div>
          <div class="stack-sm">
            <div class="grid-2">
              <input type="text" placeholder="slug (e.g. teeth)" value={slug} onInput={(e) => setSlug((e.currentTarget as HTMLInputElement).value)} autocapitalize="off" autocomplete="off" spellcheck={false} aria-label="Slug" />
              <input type="text" placeholder="Name" value={name} onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} aria-label="Name" />
            </div>
            <button type="button" class="btn btn-block" onClick={add}><Icon name="plus" size={18} /> Add item</button>
          </div>
        </section>
        {dirty && <button type="button" class="btn btn-primary btn-big btn-block" onClick={save} disabled={busy}>Save routine</button>}
      </main>
    </>
  )
}
