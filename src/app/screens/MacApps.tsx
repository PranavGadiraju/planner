// Settings > Mac apps: one-tap category triage for the bundle ids the Mac screen-time script has seen. The Day
// chart tints Mac time by these categories, so every uncategorised app is listed first with the seven chips;
// categorised apps sit below, grouped, and expand to the same chips on tap to re-categorise.
import { useEffect, useState } from 'preact/hooks'
import type { AppCategory, AppCategoryRow } from '@shared/types'
import { SubBar } from '../components/TopBar'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { ApiError } from '../data/api'
import { blockColor } from '../data/daymath'
import { CATEGORIES, CATEGORY_NAMES, displayName, filterApps, loadApps, seenLabel, setCategory, splitApps } from '../data/apps'
import '../styles/apps.css'

const tint = (c: AppCategory) => blockColor('mac', c)

export function MacApps() {
  const [rows, setRows] = useState<AppCategoryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  /** The categorised row whose chips are showing (one at a time keeps the list short). */
  const [open, setOpen] = useState<string | null>(null)

  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await loadApps()
      setRows(r.data.apps ?? [])
      setCached(r.cached)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the server')
    } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])

  const pick = async (row: AppCategoryRow, category: AppCategory) => {
    if (row.category === category) { setOpen(null); return }
    const at = new Date().toISOString()
    setRows((cur) => cur ? cur.map((r) => (r.app_id === row.app_id ? { ...r, category, updated_at: at } : r)) : cur)
    setOpen(null)
    try {
      await setCategory(row, category)
      toast(`${displayName(row)} → ${CATEGORY_NAMES[category]}`)
    } catch {
      toast('Could not queue the change', { kind: 'danger' })
    }
  }

  const visible = rows ? filterApps(rows, query) : []
  const { triage, groups } = splitApps(visible)
  const searching = query.trim() !== ''
  const total = rows?.length ?? 0

  return (
    <>
      <SubBar
        title="Mac apps"
        fallback="#/settings"
        right={<button type="button" class="icon-btn" onClick={() => void load()} aria-label="Refresh" disabled={busy}><Icon name="refresh" class={busy ? 'spin' : undefined} /></button>}
      />
      <main class="content no-tabs fade">
        <p class="app-hint">
          The Day chart tints Mac time by these categories. Pick one per app; you can change it any time. New apps
          show up here after each hourly push from the Mac.
        </p>
        {cached && <div class="banner banner-info small">Offline · showing the cached list. Changes still queue.</div>}
        {error && <div class="banner banner-danger"><span class="grow">{error}</span><button type="button" class="btn btn-sm" onClick={() => void load()}>Retry</button></div>}

        {total > 0 && (
          <div class="apps-search">
            <input
              type="search"
              value={query}
              onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
              placeholder="Search apps"
              aria-label="Search apps"
              autocomplete="off"
              autocapitalize="off"
              spellcheck={false}
            />
          </div>
        )}

        {rows === null && !error && <p class="faint small" style={{ textAlign: 'center' }}>Loading…</p>}

        {rows !== null && total === 0 && !error && (
          <div class="placeholder">
            <div class="glyph"><Icon name="work" size={28} /></div>
            <h2>No Mac apps yet</h2>
            <p>The Mac script pushes the apps it sees every hour; each new bundle id lands here for a one-time category pick.</p>
          </div>
        )}

        {searching && total > 0 && visible.length === 0 && <p class="faint small" style={{ textAlign: 'center' }}>No app matches “{query.trim()}”.</p>}

        {triage.length > 0 && (
          <section class="card app-group" aria-label="Apps to categorise">
            <div class="card-head">
              <span class="card-title">{triage.length} app{triage.length === 1 ? '' : 's'} to categorise</span>
              <span class="small faint">most used first</span>
            </div>
            <ul class="list app-list">
              {triage.map((r) => (
                <li key={r.app_id} class="app-row">
                  <AppLine row={r} />
                  <CategoryChips current={null} onPick={(c) => void pick(r, c)} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {rows !== null && total > 0 && triage.length === 0 && !searching && (
          <div class="banner banner-info small app-done"><Icon name="check" size={18} /> Every app has a category.</div>
        )}

        {groups.map((g) => (
          <section key={g.category} class="card app-group" aria-label={`${CATEGORY_NAMES[g.category]} apps`}>
            <div class="card-head">
              <span class="card-title"><i class="dot" style={`--c:${tint(g.category)}`} />{CATEGORY_NAMES[g.category]}</span>
              <span class="small faint num">{g.rows.length} app{g.rows.length === 1 ? '' : 's'} · {seenLabel(g.seconds)}</span>
            </div>
            <ul class="list app-list">
              {g.rows.map((r) => {
                const expanded = open === r.app_id
                return (
                  <li key={r.app_id} class="app-row">
                    <button type="button" class="app-main" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : r.app_id)}>
                      <AppLine row={r} />
                    </button>
                    {expanded && <CategoryChips current={r.category} onPick={(c) => void pick(r, c)} />}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </main>
    </>
  )
}

/** Name, bundle id and hours seen; the current category badge when it has one. */
function AppLine({ row }: { row: AppCategoryRow }) {
  return (
    <span class="app-line">
      <span class="app-name">{displayName(row)}</span>
      <span class="app-seen num">{seenLabel(row.seen_seconds)}</span>
      <span class="app-id">{row.app_id}</span>
      {row.category && <span class="app-cat" style={`--c:${tint(row.category)}`}><i class="dot" />{CATEGORY_NAMES[row.category]}</span>}
    </span>
  )
}

function CategoryChips({ current, onPick }: { current: AppCategory | null; onPick: (c: AppCategory) => void }) {
  return (
    <div class="chips app-chips" role="group" aria-label="Category">
      {CATEGORIES.map((c) => (
        <button key={c} type="button" class="chip-cat" style={`--c:${tint(c)}`} aria-pressed={current === c} onClick={() => onPick(c)}>
          {CATEGORY_NAMES[c]}
        </button>
      ))}
    </div>
  )
}
