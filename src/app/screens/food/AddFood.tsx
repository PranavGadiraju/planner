// Add food ('#/food/scan' | '#/food/search' | '#/food/label'): one screen, three panels behind a segmented control.
// Scan = still photo -> ponyfill -> Open Food Facts (direct) -> USDA GTIN (Worker) -> Label form with the code prefilled.
// Search = USDA by name (generic by default, Branded toggle). Label = per-serving or per-100 g numbers with a live
// per-100 preview and the 4/4/9 chip (a flag never blocks).
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Food, FoodLog } from '@shared/types'
import type { FoodCandidate } from '@shared/lookup'
import { atwaterCheck, validGtin, type Per100 } from '@shared/nutrition'
import { SubBar } from '../../components/TopBar'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { navigate } from '../../router'
import { tz } from '../../data/store'
import {
  EMPTY_LABEL_FORM, SLOT_LABELS, addFood, existingFor, fmtKcal, fmtNum, foodFromCandidate, foods, labelPer100, loadLists, lookupBarcode, searchUSDA, updateFood,
  type LabelForm, type NewFood,
} from '../../data/food'
import { LogFoodSheet, MacroLine, SourceBadge } from './common'

export type AddMode = 'scan' | 'search' | 'label'
const MODES: { mode: AddMode; label: string }[] = [{ mode: 'scan', label: 'Scan' }, { mode: 'search', label: 'Search' }, { mode: 'label', label: 'Label' }]

export function AddFood({ mode }: { mode: AddMode }) {
  const [logging, setLogging] = useState<Food | null>(null)
  const [prefillCode, setPrefillCode] = useState<string | null>(null)
  useEffect(() => { void loadLists() }, [])

  const logged = (entry: FoodLog) => {
    setLogging(null)
    toast(`${entry.label} · ${fmtKcal(entry.kcal)} kcal · ${SLOT_LABELS[entry.slot]}`)
    navigate('#/food')
  }
  const toLabel = (code: string | null) => { setPrefillCode(code); navigate('#/food/label') }

  return (
    <>
      <SubBar title="Add food" fallback="#/food" />
      <main class="content fade">
        <div class="seg seg-full" role="tablist" aria-label="How to add">
          {MODES.map((m) => (
            <button key={m.mode} type="button" role="tab" aria-selected={mode === m.mode} aria-pressed={mode === m.mode} onClick={() => navigate(`#/food/${m.mode}`)}>{m.label}</button>
          ))}
        </div>
        {mode === 'scan' && <ScanPanel onLog={setLogging} onLabel={toLabel} />}
        {mode === 'search' && <SearchPanel onLog={setLogging} />}
        {mode === 'label' && <LabelPanel prefillCode={prefillCode} onLog={setLogging} />}
      </main>
      {logging && <LogFoodSheet food={logging} at={new Date()} zone={tz.value} onDone={logged} onClose={() => setLogging(null)} />}
    </>
  )
}

// ---- scan ----------------------------------------------------------------------------------------------

type ScanPhase =
  | { kind: 'idle' }
  | { kind: 'decoding' }
  | { kind: 'nocode'; reason: string }
  | { kind: 'looking'; code: string }
  | { kind: 'found'; code: string; candidate: FoodCandidate; source: 'off' | 'usda' }
  | { kind: 'notfound'; code: string; offline: boolean }

function ScanPanel({ onLog, onLabel }: { onLog: (f: Food) => void; onLabel: (code: string | null) => void }) {
  const [phase, setPhase] = useState<ScanPhase>({ kind: 'idle' })
  const [manual, setManual] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const lookup = async (code: string) => {
    if (!validGtin(code)) { setPhase({ kind: 'nocode', reason: `${code} is not a valid EAN/UPC (check digit)` }); return }
    setPhase({ kind: 'looking', code })
    const r = await lookupBarcode(code)
    if (r.candidate && r.source) setPhase({ kind: 'found', code, candidate: r.candidate, source: r.source })
    else setPhase({ kind: 'notfound', code, offline: !!r.offline })
  }
  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = '' // the same photo can be retried
    if (!file) return
    setPhase({ kind: 'decoding' })
    try {
      const { decodeBarcode } = await import('./scan')
      const code = await decodeBarcode(file)
      if (!code) { setPhase({ kind: 'nocode', reason: 'No barcode found. Fill the frame with the code, hold still, good light.' }); return }
      await lookup(code)
    } catch (err) {
      setPhase({ kind: 'nocode', reason: `Could not decode the photo: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
  const busy = phase.kind === 'decoding' || phase.kind === 'looking'

  return (
    <div class="stack">
      <label class={`btn btn-primary btn-big btn-block scan-btn${busy ? ' busy' : ''}`}>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" class="sr-only" onChange={(e) => void onFile(e)} disabled={busy} />
        <Icon name="tag" size={20} /> {phase.kind === 'decoding' ? 'Reading the photo…' : phase.kind === 'looking' ? `Looking up ${phase.code}…` : 'Take photo of barcode'}
      </label>
      <p class="small faint" style="padding: 0 4px">A still photo is decoded on the phone (EAN-13, UPC-A, EAN-8, UPC-E); then Open Food Facts, then USDA.</p>
      <div class="row">
        <input class="grow num" type="text" inputMode="numeric" pattern="[0-9]*" value={manual} placeholder="…or type the digits" aria-label="Barcode digits" autocomplete="off" onInput={(e) => setManual((e.currentTarget as HTMLInputElement).value.replace(/\D/g, ''))} onKeyDown={(e) => { if (e.key === 'Enter' && manual.length >= 8) void lookup(manual) }} enterkeyhint="search" />
        <button type="button" class="btn" disabled={manual.length < 8 || busy} onClick={() => void lookup(manual)}>Look up</button>
      </div>
      {phase.kind === 'nocode' && <div class="banner banner-danger"><span class="grow small">{phase.reason}</span></div>}
      {phase.kind === 'notfound' && (
        <div class="banner">
          <span class="grow small"><strong>{phase.code}</strong> {phase.offline ? 'could not be looked up (offline?).' : 'is not in Open Food Facts or USDA.'} Type the label instead.</span>
          <button type="button" class="btn btn-sm" onClick={() => onLabel(phase.code)}>Add by label</button>
        </div>
      )}
      {phase.kind === 'found' && (
        <CandidateCard key={phase.code} candidate={phase.candidate} code={phase.code} onLog={onLog} onSaved={() => setPhase({ kind: 'idle' })} />
      )}
    </div>
  )
}

/** Editable candidate (name, brand, per-100 numbers, serving) with Log now / Save only. */
function CandidateCard({ candidate, code, onLog, onSaved }: { candidate: FoodCandidate; code: string; onLog: (f: Food) => void; onSaved: () => void }) {
  const [name, setName] = useState(candidate.name)
  const [brand, setBrand] = useState(candidate.brand ?? '')
  const [p, setP] = useState<Per100>({
    kcal_100: candidate.kcal_100, protein_100: candidate.protein_100, carb_100: candidate.carb_100, fat_100: candidate.fat_100,
    fiber_100: candidate.fiber_100, sugar_100: candidate.sugar_100,
  })
  const [servingG, setServingG] = useState(candidate.serving_g ? String(candidate.serving_g) : '')
  const [servingText, setServingText] = useState(candidate.serving_text ?? '')
  const [busy, setBusy] = useState(false)
  const existing = existingFor(candidate, foods.value)
  const check = atwaterCheck({ kcal: p.kcal_100, protein_g: p.protein_100, carb_g: p.carb_100, fat_g: p.fat_100 })

  const build = (): NewFood => ({
    name: name.trim() || candidate.name, brand: brand.trim() || null, source: candidate.source, source_id: candidate.source_id, per100: p,
    serving_g: Number(servingG) > 0 ? Number(servingG) : null, serving_text: servingText.trim() || null,
    label_json: JSON.stringify({ barcode: code, fetched: candidate }),
  })
  const persist = async (): Promise<Food> => {
    const n = build()
    if (existing) {
      return updateFood(existing, {
        name: n.name, brand: n.brand, kcal_100: n.per100.kcal_100, protein_100: n.per100.protein_100, carb_100: n.per100.carb_100, fat_100: n.per100.fat_100,
        fiber_100: n.per100.fiber_100 ?? null, sugar_100: n.per100.sugar_100 ?? null, serving_g: n.serving_g, serving_text: n.serving_text,
      })
    }
    return addFood(n)
  }
  const save = async (thenLog: boolean) => {
    if (!name.trim()) { toast('Name required', { kind: 'danger' }); return }
    setBusy(true)
    try {
      const f = await persist()
      if (thenLog) onLog(f)
      else { toast(`${existing ? 'Updated' : 'Saved'} ${f.name}`); onSaved() }
    } finally { setBusy(false) }
  }

  return (
    <section class="card cand-card">
      <div class="card-head">
        <span class="card-title">Found · {code}</span>
        <span class="row" style="gap: 6px">
          {existing && <span class="badge badge-ok">already saved</span>}
          <SourceBadge source={candidate.source} />
        </span>
      </div>
      {!candidate.complete && <div class="banner" style="margin-bottom: 10px"><span class="grow small">Some macros were missing in the source and read 0. Check them before logging.</span></div>}
      <div class="stack-sm">
        <input type="text" value={name} aria-label="Name" placeholder="Name" onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
        <input type="text" value={brand} aria-label="Brand" placeholder="Brand (optional)" onInput={(e) => setBrand((e.currentTarget as HTMLInputElement).value)} />
        <Per100Grid value={p} onChange={setP} />
        <div class="grid-2">
          <div class="field"><label for="cand-serving">Serving (g)</label><input id="cand-serving" type="number" inputMode="decimal" min={0} step="any" value={servingG} onInput={(e) => setServingG((e.currentTarget as HTMLInputElement).value)} /></div>
          <div class="field"><label for="cand-serving-text">Serving text</label><input id="cand-serving-text" type="text" value={servingText} placeholder="1 cup (39 g)" onInput={(e) => setServingText((e.currentTarget as HTMLInputElement).value)} /></div>
        </div>
        <AtwaterChip check={check} kcal={p.kcal_100} />
        <div class="grid-2">
          <button type="button" class="btn btn-big" onClick={() => void save(false)} disabled={busy}>Save only</button>
          <button type="button" class="btn btn-big btn-primary" onClick={() => void save(true)} disabled={busy}><Icon name="check" size={18} /> Log now</button>
        </div>
      </div>
    </section>
  )
}

const P100_FIELDS: { key: keyof Per100; label: string; opt?: boolean }[] = [
  { key: 'kcal_100', label: 'kcal' }, { key: 'protein_100', label: 'Protein g' }, { key: 'carb_100', label: 'Carbs g' }, { key: 'fat_100', label: 'Fat g' },
  { key: 'fiber_100', label: 'Fiber g', opt: true }, { key: 'sugar_100', label: 'Sugar g', opt: true },
]

function Per100Grid({ value, onChange }: { value: Per100; onChange: (p: Per100) => void }) {
  const setField = (key: keyof Per100, raw: string) => {
    const n = raw.trim() === '' ? null : Number(raw)
    onChange({ ...value, [key]: n === null ? (key === 'fiber_100' || key === 'sugar_100' ? null : 0) : Number.isFinite(n) ? n : 0 })
  }
  return (
    <div class="field">
      <span class="label">Per 100 g</span>
      <div class="num-grid">
        {P100_FIELDS.map((f) => {
          const v = value[f.key]
          return (
            <label key={f.key} class="num-cell">
              <span>{f.label}</span>
              <input type="number" inputMode="decimal" min={0} step="any" value={v == null ? '' : String(v)} placeholder={f.opt ? '–' : '0'} aria-label={`${f.label} per 100 g`} onInput={(e) => setField(f.key, (e.currentTarget as HTMLInputElement).value)} />
            </label>
          )
        })}
      </div>
    </div>
  )
}

function AtwaterChip({ check, kcal }: { check: ReturnType<typeof atwaterCheck>; kcal: number }) {
  return (
    <span class={`atwater ${check.ok ? 'ok' : 'flag'} num`} title="4 × protein + 4 × carbs + 9 × fat vs the stated kcal">
      <Icon name={check.ok ? 'check' : 'tag'} size={14} stroke={2.2} />
      4/4/9 → {fmtKcal(check.implied)} kcal vs {fmtKcal(kcal)}{check.ok ? '' : ` · ${fmtKcal(check.diff)} off (${check.pct}%) — check the digits`}
    </span>
  )
}

// ---- search --------------------------------------------------------------------------------------------

function SearchPanel({ onLog }: { onLog: (f: Food) => void }) {
  const [q, setQ] = useState('')
  const [type, setType] = useState<'generic' | 'branded'>('generic')
  const [state, setState] = useState<{ q: string; type: string; loading: boolean; error: string | null; list: FoodCandidate[]; demo: boolean } | null>(null)
  const run = async (t = type) => {
    const query = q.trim()
    if (query.length < 2) return
    setState({ q: query, type: t, loading: true, error: null, list: [], demo: false })
    try {
      const r = await searchUSDA(query, t)
      setState({ q: query, type: t, loading: false, error: null, list: r.candidates, demo: !!r.demo_key })
    } catch (err) {
      setState({ q: query, type: t, loading: false, error: err instanceof Error ? err.message : 'Search failed', list: [], demo: false })
    }
  }
  const ensure = async (c: FoodCandidate) => existingFor(c, foods.value) ?? (await addFood(foodFromCandidate(c)))
  return (
    <div class="stack">
      <div class="row">
        <input class="grow" type="search" value={q} placeholder="USDA: oats, chicken thigh, cheerios…" aria-label="USDA search" autocomplete="off" enterkeyhint="search" onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} onKeyDown={(e) => { if (e.key === 'Enter') void run() }} />
        <button type="button" class="btn btn-primary" disabled={q.trim().length < 2} onClick={() => void run()}>Search</button>
      </div>
      <div class="row">
        <div class="seg" role="group" aria-label="USDA data type">
          <button type="button" aria-pressed={type === 'generic'} onClick={() => { setType('generic'); if (state) void run('generic') }}>Generic</button>
          <button type="button" aria-pressed={type === 'branded'} onClick={() => { setType('branded'); if (state) void run('branded') }}>Branded</button>
        </div>
        <span class="small faint">{type === 'generic' ? 'Foundation + SR Legacy' : 'Packaged products'}</span>
      </div>
      {state?.loading && <p class="small muted">Searching USDA for “{state.q}”…</p>}
      {state?.error && <div class="banner banner-danger"><span class="grow small">{state.error}</span></div>}
      {state && !state.loading && !state.error && state.list.length === 0 && <p class="small muted">No matches for “{state.q}”.</p>}
      {state?.demo && <p class="small faint">Using USDA’s shared DEMO_KEY (rate-limited). Set USDA_KEY on the Worker for your own quota.</p>}
      {state && state.list.length > 0 && (
        <section class="card">
          <div class="list">
            {state.list.map((c) => (
              <div key={c.source_id} class="cand-row">
                <span class="result-main">
                  <span class="result-name">{c.name}</span>
                  <span class="result-sub">{c.brand ? `${c.brand} · ` : ''}{fmtKcal(c.kcal_100)} kcal / 100 g · {fmtNum(c.protein_100)}P {fmtNum(c.carb_100)}C {fmtNum(c.fat_100)}F{c.serving_text ? ` · ${c.serving_text}` : ''}</span>
                </span>
                <span class="cand-actions">
                  <button type="button" class="btn btn-sm" onClick={() => void ensure(c).then((f) => toast(`Saved ${f.name}`))}>Save</button>
                  <button type="button" class="btn btn-sm btn-primary" onClick={() => void ensure(c).then(onLog)}>Log now</button>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// ---- label ---------------------------------------------------------------------------------------------

function LabelPanel({ prefillCode, onLog }: { prefillCode: string | null; onLog: (f: Food) => void }) {
  const [f, setF] = useState<LabelForm>(EMPTY_LABEL_FORM)
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<LabelForm>) => setF((cur) => ({ ...cur, ...patch }))
  const calc = labelPer100(f)
  const check = calc ? atwaterCheck(calc.basis) : null
  const field = (key: keyof LabelForm, label: string, opts: { placeholder?: string; optional?: boolean; text?: boolean } = {}) => (
    <label class="num-cell" key={key}>
      <span>{label}{opts.optional ? <span class="faint"> (opt)</span> : ''}</span>
      <input type={opts.text ? 'text' : 'number'} inputMode={opts.text ? undefined : 'decimal'} min={0} step="any" value={f[key]} placeholder={opts.placeholder ?? ''} aria-label={label} onInput={(e) => set({ [key]: (e.currentTarget as HTMLInputElement).value } as Partial<LabelForm>)} />
    </label>
  )
  const save = async (thenLog: boolean) => {
    if (!f.name.trim()) { toast('Name required', { kind: 'danger' }); return }
    if (!calc) { toast('Serving grams are required in per-serving mode', { kind: 'danger' }); return }
    if (!(calc.per100.kcal_100 > 0) && !(calc.per100.protein_100 + calc.per100.carb_100 + calc.per100.fat_100 > 0)) { toast('Enter the label numbers', { kind: 'danger' }); return }
    setBusy(true)
    try {
      const food = await addFood({
        name: f.name, brand: f.brand || null, source: 'label', source_id: prefillCode, per100: calc.per100,
        serving_g: calc.serving_g, serving_text: f.serving_text || null,
        label_json: JSON.stringify({ mode: f.mode, serving_g: f.serving_g, serving_text: f.serving_text, kcal: f.kcal, protein_g: f.protein, carb_g: f.carb, fat_g: f.fat, fiber_g: f.fiber, sugar_g: f.sugar, barcode: prefillCode }),
      })
      if (thenLog) onLog(food)
      else { toast(`Saved ${food.name}`); setF(EMPTY_LABEL_FORM) }
    } finally { setBusy(false) }
  }
  const perServing = f.mode === 'serving'
  return (
    <div class="stack">
      {prefillCode && <div class="banner banner-info"><span class="grow small">Barcode <b class="num">{prefillCode}</b> will be stored with this food so the next scan finds it.</span></div>}
      <section class="card">
        <div class="stack-sm">
          <input type="text" value={f.name} placeholder="Name" aria-label="Name" onInput={(e) => set({ name: (e.currentTarget as HTMLInputElement).value })} />
          <input type="text" value={f.brand} placeholder="Brand (optional)" aria-label="Brand" onInput={(e) => set({ brand: (e.currentTarget as HTMLInputElement).value })} />
          <div class="row">
            <div class="seg" role="group" aria-label="Label mode">
              <button type="button" aria-pressed={perServing} onClick={() => set({ mode: 'serving' })}>per serving</button>
              <button type="button" aria-pressed={!perServing} onClick={() => set({ mode: 'per100' })}>per 100 g</button>
            </div>
            <span class="small faint">{perServing ? 'as printed, plus serving grams' : 'values already per 100 g'}</span>
          </div>
          <div class="num-grid">
            {perServing && field('serving_g', 'Serving g', { placeholder: 'required' })}
            {field('serving_text', 'Serving text', { text: true, placeholder: perServing ? '2/3 cup (55 g)' : 'optional', optional: !perServing })}
          </div>
          <div class="num-grid">
            {field('kcal', perServing ? 'kcal / serving' : 'kcal / 100 g')}
            {field('protein', 'Protein g')}
            {field('carb', 'Carbs g')}
            {field('fat', 'Fat g')}
            {field('fiber', 'Fiber g', { optional: true })}
            {field('sugar', 'Sugar g', { optional: true })}
          </div>
          <div class="label-preview">
            <span class="card-title">Per 100 g</span>
            {calc ? <MacroLine p={calc.per100} /> : <span class="small muted">Enter the serving grams to convert.</span>}
            {check && <AtwaterChip check={check} kcal={calc ? calc.basis.kcal : 0} />}
          </div>
          <div class="grid-2">
            <button type="button" class="btn btn-big" onClick={() => void save(false)} disabled={busy}>Save</button>
            <button type="button" class="btn btn-big btn-primary" onClick={() => void save(true)} disabled={busy}><Icon name="check" size={18} /> Save &amp; log</button>
          </div>
        </div>
      </section>
      <p class="small faint" style="padding: 0 4px">Read the digits as printed; the 4/4/9 chip flags a mismatch but never blocks.</p>
    </div>
  )
}
