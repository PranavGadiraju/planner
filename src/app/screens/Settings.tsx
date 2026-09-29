// Settings: token + test, preferences, links (projects, exercises, routine, shortcut, taps, Mac apps), the
// automation health rows, and the data tools (force sync, server export, cache export, reset).
import { useEffect, useState } from 'preact/hooks'
import { clear, entries, set } from 'idb-keyval'
import type { HealthRow, Settings as SettingsT } from '@shared/types'
import { SubBar } from '../components/TopBar'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { ApiError, setToken, token } from '../data/api'
import * as outbox from '../data/outbox'
import { loadToday, now, saveSettings, settings, syncState, today } from '../data/store'
import { agoLabel, minusMinutes } from '../data/format'

const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

export function Settings() {
  const triage = today.value?.health.apps_to_triage ?? 0
  const version = useWorkerVersion()
  return (
    <>
      <SubBar title="Settings" fallback="#/" />
      <main class="content no-tabs fade">
        <TokenSection />
        <PrefsSection />
        <section class="card" aria-label="More">
          <div class="list">
            <a class="list-row list-link" href="#/work"><Icon name="journal" /><span class="grow">Projects</span><Icon name="chevron" size={18} /></a>
            <a class="list-row list-link" href="#/lift/exercises"><Icon name="lift" /><span class="grow">Exercises</span><Icon name="chevron" size={18} /></a>
            <a class="list-row list-link" href="#/settings/routine"><Icon name="list" /><span class="grow">Routine items</span><Icon name="chevron" size={18} /></a>
            <a class="list-row list-link" href="#/settings/shortcut"><Icon name="link" /><span class="grow">Shortcut &amp; NFC setup</span><Icon name="chevron" size={18} /></a>
            <a class="list-row list-link" href="#/settings/taps"><Icon name="tag" /><span class="grow">NFC tap log</span><Icon name="chevron" size={18} /></a>
            <a class="list-row list-link" href="#/settings/apps">
              <Icon name="work" />
              <span class="grow">Mac apps{triage > 0 && <span class="faint"> · {triage} to categorise</span>}</span>
              <Icon name="chevron" size={18} />
            </a>
          </div>
        </section>
        <HealthSection />
        <ToolsSection />
        <p class="faint small" style={{ textAlign: 'center' }}>
          {version ? `Planner ${version}` : 'planner'} · {isStandalone() ? 'installed' : 'in browser — Share → Add to Home Screen to install'}
        </p>
      </main>
    </>
  )
}

function isStandalone(): boolean {
  try { return matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true } catch { return false }
}

// The Worker's APP_VERSION from the public GET /api/health, fetched once per page load (undefined = not asked yet).
let versionCache: string | null | undefined
function useWorkerVersion(): string | null {
  const [v, setV] = useState<string | null>(versionCache ?? null)
  useEffect(() => {
    if (versionCache !== undefined) { setV(versionCache); return }
    let alive = true
    void fetch('/api/health', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<unknown>) : null))
      .then((j) => {
        const ver = j && typeof j === 'object' && typeof (j as { version?: unknown }).version === 'string' ? (j as { version: string }).version : null
        versionCache = ver
        if (alive) setV(ver)
      })
      .catch(() => { versionCache = null })
    return () => { alive = false }
  }, [])
  return v
}

// ---- automation health -----------------------------------------------------------------------------

const SOURCE_NAMES: Record<string, string> = { mac: 'Mac screen-time push', phone: 'Phone screen time', nfc: 'NFC stickers', cron: 'Nightly rollup', cli: 'CLI' }

/** ok = the last success is newer than the last error; error = the other way round; never = no success yet. */
export function healthTone(r: Pick<HealthRow, 'last_ok_at' | 'last_error_at'>): 'ok' | 'error' | 'never' {
  if (r.last_error_at && (!r.last_ok_at || r.last_error_at > r.last_ok_at)) return 'error'
  return r.last_ok_at ? 'ok' : 'never'
}

/** The automation_health rows the Today payload carries, laid out like `planner health`. */
function HealthSection() {
  const p = today.value
  const at = now.value
  if (!p) return null
  const rows = p.health.rows
  return (
    <section class="card" aria-label="Automation health">
      <div class="card-head">
        <span class="card-title">Automation health</span>
        <span class="small faint num">{p.health.taps_today} tap{p.health.taps_today === 1 ? '' : 's'} today</span>
      </div>
      {rows.length === 0 ? (
        <p class="small faint">Nothing has reported yet: the Mac push, the stickers and the nightly rollup each add a row here.</p>
      ) : (
        <div class="list">
          {rows.map((r) => {
            const tone = healthTone(r)
            return (
              <div key={r.source} class="list-row health-row">
                <div class="grow">
                  <div class="health-src">{SOURCE_NAMES[r.source] ?? r.source}</div>
                  <div class="small faint">
                    {r.last_ok_at ? `last ok ${agoLabel(r.last_ok_at, at)}` : 'never ok'}{r.detail ? ` · ${r.detail}` : ''}
                  </div>
                  {r.last_error_at && (
                    <div class="small health-err">error {agoLabel(r.last_error_at, at)}{r.last_error ? `: ${r.last_error}` : ''}</div>
                  )}
                </div>
                <span class={`badge ${tone === 'ok' ? 'badge-ok' : tone === 'error' ? 'badge-danger' : ''}`}>{tone}</span>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

/** Hand a JSON text to the browser as a file (a blob link; nothing is kept in storage). */
function downloadJson(name: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function TokenSection() {
  const stored = token.value ?? ''
  const [draft, setDraft] = useState(stored)
  const [touched, setTouched] = useState(false)
  const [show, setShow] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'bad' | 'busy'; text: string } | null>(null)
  const state = syncState.value

  // The token can arrive after mount (restored from IndexedDB); follow it until the user starts typing.
  useEffect(() => { if (!touched) setDraft(stored) }, [stored, touched])

  const edit = (v: string) => { setDraft(v); setTouched(true) }
  const commit = () => {
    // An untouched empty field (nothing restored yet) must not wipe a token that is still loading.
    if (!touched && !draft.trim()) return
    if (draft.trim() !== stored) setToken(draft)
    setTouched(false)
  }
  const test = async () => {
    commit()
    setStatus({ kind: 'busy', text: 'Testing…' })
    try {
      const r = await fetch('/api/me', { headers: { Authorization: `Bearer ${draft.trim()}` }, cache: 'no-store' })
      if (r.status === 401) { setStatus({ kind: 'bad', text: 'Token rejected (401)' }); return }
      if (!r.ok) { setStatus({ kind: 'bad', text: `Server answered ${r.status}` }); return }
      const me = (await r.json()) as { role: string; tz: string; today: string; server_time: string }
      setStatus({ kind: 'ok', text: `OK · role ${me.role} · ${me.tz} · today ${me.today}` })
      void outbox.flush()
      void loadToday()
    } catch (err) {
      setStatus({ kind: 'bad', text: err instanceof ApiError ? err.message : 'Cannot reach the server' })
    }
  }
  return (
    <section class="card" aria-label="App token">
      <div class="card-head">
        <span class="card-title">App token</span>
        <span class={`badge ${state === 'synced' || state === 'pending' || state === 'offline' ? 'badge-ok' : 'badge-danger'}`}>
          {state === 'no-token' ? 'missing' : state === 'unauthorized' ? 'rejected' : 'set'}
        </span>
      </div>
      <div class="stack-sm">
        <div class="row">
          <input
            class="grow mono"
            type={show ? 'text' : 'password'}
            placeholder="Paste APP_TOKEN"
            value={draft}
            onInput={(e) => edit((e.currentTarget as HTMLInputElement).value)}
            onBlur={commit}
            autocomplete="off"
            autocapitalize="off"
            spellcheck={false}
            aria-label="App token"
          />
          <button type="button" class="btn btn-ghost" onClick={() => setShow(!show)} aria-pressed={show}>{show ? 'Hide' : 'Show'}</button>
        </div>
        <div class="row">
          <button type="button" class="btn btn-primary" onClick={test} disabled={!draft.trim() || status?.kind === 'busy'}>Test</button>
          <span class={`small grow ${status?.kind === 'bad' ? 'warn' : 'muted'}`} style={status?.kind === 'bad' ? { color: 'var(--danger)' } : undefined}>
            {status?.text ?? 'Calls GET /api/me with this token.'}
          </span>
        </div>
      </div>
    </section>
  )
}

interface PrefsForm { tz: string; unit: SettingsT['weight_unit']; kcal: string; protein: string; carb: string; fat: string; bed: string; wind: string; grace: string }
function formFrom(s: SettingsT): PrefsForm {
  return {
    tz: s.tz, unit: s.weight_unit, kcal: String(s.targets.kcal), protein: String(s.targets.protein_g), carb: String(s.targets.carb_g),
    fat: String(s.targets.fat_g), bed: s.bed_target, wind: String(s.winddown_min), grace: String(s.late_grace_min),
  }
}

function PrefsSection() {
  const s = settings.value
  const [form, setForm] = useState<PrefsForm>(() => formFrom(s))
  const [touched, setTouched] = useState(false)
  // Settings load after mount on a cold start at #/settings: mirror the store until the user edits something.
  useEffect(() => { if (!touched) setForm(formFrom(s)) }, [s, touched])
  const { tz, unit, kcal, protein, carb, fat, bed, wind, grace } = form
  const edit = (patch: Partial<PrefsForm>) => { setForm((f) => ({ ...f, ...patch })); setTouched(true) }
  const setTz = (v: string) => edit({ tz: v })
  const setUnit = (v: SettingsT['weight_unit']) => edit({ unit: v })
  const setKcal = (v: string) => edit({ kcal: v })
  const setProtein = (v: string) => edit({ protein: v })
  const setCarb = (v: string) => edit({ carb: v })
  const setFat = (v: string) => edit({ fat: v })
  const setBed = (v: string) => edit({ bed: v })
  const setWind = (v: string) => edit({ wind: v })
  const setGrace = (v: string) => edit({ grace: v })

  const num = (v: string, fallback: number) => { const n = Number(v); return Number.isFinite(n) && v.trim() !== '' ? n : fallback }
  const patch = (): Partial<SettingsT> => {
    const out: Partial<SettingsT> = {}
    if (tz.trim() && tz.trim() !== s.tz) out.tz = tz.trim()
    if (unit !== s.weight_unit) out.weight_unit = unit
    const targets = { kcal: num(kcal, s.targets.kcal), protein_g: num(protein, s.targets.protein_g), carb_g: num(carb, s.targets.carb_g), fat_g: num(fat, s.targets.fat_g) }
    if (JSON.stringify(targets) !== JSON.stringify(s.targets)) out.targets = targets
    if (/^\d{2}:\d{2}$/.test(bed) && bed !== s.bed_target) out.bed_target = bed
    if (num(wind, s.winddown_min) !== s.winddown_min) out.winddown_min = num(wind, s.winddown_min)
    if (num(grace, s.late_grace_min) !== s.late_grace_min) out.late_grace_min = num(grace, s.late_grace_min)
    return out
  }
  const dirty = Object.keys(patch()).length > 0
  const validTz = (() => { try { Intl.DateTimeFormat(undefined, { timeZone: tz.trim() }); return true } catch { return false } })()

  const save = async () => {
    if (!validTz) { toast('Unknown timezone', { kind: 'danger' }); return }
    const p = patch()
    await saveSettings(p)
    setTouched(false) // the store now carries the saved values; follow it again
    toast('Settings saved')
    if (p.bed_target || p.winddown_min !== undefined) {
      const b = p.bed_target ?? s.bed_target
      const w = p.winddown_min ?? s.winddown_min
      toast(`Update the wind-down automation to ${minusMinutes(b, w)}`, { duration: 6000 })
    }
  }

  return (
    <section class="card" aria-label="Preferences">
      <div class="card-head"><span class="card-title">Preferences</span></div>
      <div class="stack">
        <div class="field">
          <label for="pref-tz">Timezone</label>
          <div class="row">
            <input id="pref-tz" class="grow" type="text" value={tz} onInput={(e) => setTz((e.currentTarget as HTMLInputElement).value)} placeholder={DEVICE_TZ} autocapitalize="off" autocomplete="off" spellcheck={false} />
            {tz.trim() !== DEVICE_TZ && <button type="button" class="btn btn-ghost btn-sm" onClick={() => setTz(DEVICE_TZ)}>Use device</button>}
          </div>
          {!validTz && <span class="small" style={{ color: 'var(--danger)' }}>Not a valid IANA timezone.</span>}
        </div>
        <div class="field">
          <span class="label">Weight unit</span>
          <div class="seg" role="group" aria-label="Weight unit">
            <button type="button" aria-pressed={unit === 'lb'} onClick={() => setUnit('lb')}>lb</button>
            <button type="button" aria-pressed={unit === 'kg'} onClick={() => setUnit('kg')}>kg</button>
          </div>
        </div>
        <div class="field">
          <span class="label">Daily targets</span>
          <div class="grid-4">
            <NumField id="t-kcal" label="kcal" value={kcal} onChange={setKcal} />
            <NumField id="t-p" label="protein g" value={protein} onChange={setProtein} />
            <NumField id="t-c" label="carbs g" value={carb} onChange={setCarb} />
            <NumField id="t-f" label="fat g" value={fat} onChange={setFat} />
          </div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="pref-bed">Bed target</label>
            <input id="pref-bed" type="time" value={bed} onInput={(e) => setBed((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label for="pref-wind">Wind-down (min)</label>
            <input id="pref-wind" type="number" inputMode="numeric" min={0} max={240} value={wind} onInput={(e) => setWind((e.currentTarget as HTMLInputElement).value)} />
          </div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="pref-grace">Late grace (min)</label>
            <input id="pref-grace" type="number" inputMode="numeric" min={0} max={120} value={grace} onInput={(e) => setGrace((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <span class="label">Wind-down reminder</span>
            <span class="input num" style={{ display: 'flex', alignItems: 'center', color: 'var(--text-2)' }}>{/^\d{2}:\d{2}$/.test(bed) ? minusMinutes(bed, num(wind, s.winddown_min)) : '—'}</span>
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-block" onClick={save} disabled={!dirty}>Save preferences</button>
      </div>
    </section>
  )
}

function NumField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div class="field">
      <label for={id} class="small">{label}</label>
      <input id={id} type="number" inputMode="decimal" min={0} value={value} onInput={(e) => onChange((e.currentTarget as HTMLInputElement).value)} style={{ padding: '10px 8px' }} />
    </div>
  )
}

function ToolsSection() {
  const [busy, setBusy] = useState<string | null>(null)
  const force = async () => {
    setBusy('sync')
    try {
      await outbox.flush()
      await loadToday()
      toast(outbox.lastError.value ? `Sync failed: ${outbox.lastError.value}` : 'Synced', outbox.lastError.value ? { kind: 'danger' } : {})
    } finally { setBusy(null) }
  }
  // GET /api/export (every table, capped per table) straight to a file; the token travels only in the header.
  const exportData = async () => {
    const t = token.value
    if (!t) { toast('Paste the app token first', { kind: 'danger' }); return }
    setBusy('data')
    try {
      const r = await fetch('/api/export', { headers: { Authorization: `Bearer ${t}`, Accept: 'application/json' }, cache: 'no-store' })
      if (!r.ok) { toast(r.status === 401 ? 'Token rejected' : r.status === 403 ? 'Token has the wrong role' : `Export failed (${r.status})`, { kind: 'danger' }); return }
      downloadJson(`planner-export-${new Date().toISOString().slice(0, 10)}.json`, await r.text())
      toast('Export downloaded')
    } catch {
      toast('Cannot reach the server', { kind: 'danger' })
    } finally { setBusy(null) }
  }
  const exportCache = async () => {
    setBusy('export')
    try {
      const idb = await entries()
      const local: Record<string, string | null> = {}
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k !== 'planner.token') local[k] = localStorage.getItem(k) } } catch { /* ignore */ }
      const dump = { exported_at: new Date().toISOString(), idb: idb.filter(([k]) => k !== 'planner.token').map(([k, v]) => ({ key: String(k), value: v })), localStorage: local }
      downloadJson(`planner-cache-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(dump, null, 2))
    } finally { setBusy(null) }
  }
  const reset = async () => {
    const n = outbox.pending.value
    if (!confirm(n > 0 ? `Discard ${n} unsent change${n === 1 ? '' : 's'} and clear the local cache?` : 'Clear the local cache? The token is kept.')) return
    setBusy('reset')
    try {
      const t = token.value
      await clear()
      try { const keep = t; localStorage.clear(); if (keep) localStorage.setItem('planner.token', keep) } catch { /* ignore */ }
      if (t) await set('planner.token', t)
      location.reload()
    } finally { setBusy(null) }
  }
  return (
    <section class="card" aria-label="Tools">
      <div class="card-head"><span class="card-title">Data</span><span class="small faint num">{outbox.pending.value} pending</span></div>
      <div class="stack-sm">
        <button type="button" class="btn btn-block" onClick={force} disabled={busy !== null}><Icon name="refresh" size={18} class={busy === 'sync' ? 'spin' : undefined} /> Force sync</button>
        <button type="button" class="btn btn-block" onClick={exportData} disabled={busy !== null}><Icon name="copy" size={18} /> Export data</button>
        <button type="button" class="btn btn-block" onClick={exportCache} disabled={busy !== null}>Export cache</button>
        <button type="button" class="btn btn-danger btn-block" onClick={reset} disabled={busy !== null}>Reset local cache</button>
      </div>
    </section>
  )
}
