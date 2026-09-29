// Settings: token + test, preferences, links, and local-cache tools.
import { useState } from 'preact/hooks'
import { clear, entries, set } from 'idb-keyval'
import type { Settings as SettingsT } from '@shared/types'
import { SubBar } from '../components/TopBar'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { ApiError, apiGet, setToken, token } from '../data/api'
import * as outbox from '../data/outbox'
import { loadToday, saveSettings, settings, syncState } from '../data/store'
import { minusMinutes } from '../data/format'

const DEVICE_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone

export function Settings() {
  return (
    <>
      <SubBar title="Settings" fallback="#/" />
      <main class="content no-tabs fade">
        <TokenSection />
        <PrefsSection />
        <section class="card" aria-label="More">
          <div class="list">
            <a class="list-row list-link" href="#/settings/routine"><Icon name="list" /><span class="grow">Routine items</span><Icon name="chevron" size={18} /></a>
            <a class="list-row list-link" href="#/settings/shortcut"><Icon name="link" /><span class="grow">Shortcut &amp; NFC setup</span><Icon name="chevron" size={18} /></a>
            <a class="list-row list-link" href="#/settings/taps"><Icon name="tag" /><span class="grow">NFC tap log</span><Icon name="chevron" size={18} /></a>
          </div>
        </section>
        <ToolsSection />
        <p class="faint small" style={{ textAlign: 'center' }}>Planner · milestone 1 · {isStandalone() ? 'installed' : 'in browser — Share → Add to Home Screen to install'}</p>
      </main>
    </>
  )
}

function isStandalone(): boolean {
  try { return matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true } catch { return false }
}

function TokenSection() {
  const [draft, setDraft] = useState(token.value ?? '')
  const [show, setShow] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'bad' | 'busy'; text: string } | null>(null)
  const state = syncState.value

  const commit = () => { if (draft.trim() !== (token.value ?? '')) setToken(draft) }
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
            onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
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

function PrefsSection() {
  const s = settings.value
  const [tz, setTz] = useState(s.tz)
  const [unit, setUnit] = useState<SettingsT['weight_unit']>(s.weight_unit)
  const [kcal, setKcal] = useState(String(s.targets.kcal))
  const [protein, setProtein] = useState(String(s.targets.protein_g))
  const [carb, setCarb] = useState(String(s.targets.carb_g))
  const [fat, setFat] = useState(String(s.targets.fat_g))
  const [bed, setBed] = useState(s.bed_target)
  const [wind, setWind] = useState(String(s.winddown_min))
  const [grace, setGrace] = useState(String(s.late_grace_min))

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
  const exportCache = async () => {
    setBusy('export')
    try {
      const idb = await entries()
      const local: Record<string, string | null> = {}
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k !== 'planner.token') local[k] = localStorage.getItem(k) } } catch { /* ignore */ }
      const dump = { exported_at: new Date().toISOString(), idb: idb.filter(([k]) => k !== 'planner.token').map(([k, v]) => ({ key: String(k), value: v })), localStorage: local }
      const blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `planner-cache-${new Date().toISOString().slice(0, 10)}.json`
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
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
      <div class="card-head"><span class="card-title">Local data</span><span class="small faint num">{outbox.pending.value} pending</span></div>
      <div class="stack-sm">
        <button type="button" class="btn btn-block" onClick={force} disabled={busy !== null}><Icon name="refresh" size={18} class={busy === 'sync' ? 'spin' : undefined} /> Force sync</button>
        <button type="button" class="btn btn-block" onClick={exportCache} disabled={busy !== null}>Export cache</button>
        <button type="button" class="btn btn-danger btn-block" onClick={reset} disabled={busy !== null}>Reset local cache</button>
      </div>
    </section>
  )
}
