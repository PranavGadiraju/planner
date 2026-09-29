// Food home ('#/food'): kcal + P/C/F vs targets for the chosen day, quick-add meal tiles (tap = 1x now, long-press =
// portion sheet), instant local search with a USDA "more" link, the day's log grouped by slot (tap = edit sheet,
// Select -> Save as meal), and the three entry points (Scan, Add by label, New meal).
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Food, FoodLog, Meal, Slot } from '@shared/types'
import type { FoodCandidate } from '@shared/lookup'
import { addDays } from '@shared/tz'
import { TopBar } from '../../components/TopBar'
import { Sheet } from '../../components/Sheet'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { navigate } from '../../router'
import { dayLabel } from '../../data/format'
import { localToday, settings, syncState, tz } from '../../data/store'
import {
  SLOT_LABELS, addFood, dayTotals, deleteEntry, editEntry, entryDetail, existingFor, fmtKcal, fmtNum, foodFromCandidate, foods, groupBySlot,
  listsError, listsLoaded, loadLists, loadLog, logMeal, logState, meals, restoreEntry, saveAsMeal, searchLocal, searchUSDA, slotAt, topMeals, type SearchHit,
} from '../../data/food'
import { GramsPad, LogFoodSheet, PortionSheet, SlotChips, SourceBadge, atFor, showSourceInRow, useLongPress } from './common'

type SheetState =
  | { kind: 'food'; food: Food }
  | { kind: 'meal'; meal: Meal }
  | { kind: 'edit'; entry: FoodLog }
  | { kind: 'saveMeal'; entries: FoodLog[] }

interface UsdaState { q: string; type: 'generic' | 'branded'; loading: boolean; error: string | null; candidates: FoodCandidate[]; demo: boolean }

export function FoodHome({ focusSearch }: { focusSearch: boolean }) {
  const zone = tz.value
  const todayStr = localToday.value
  // The day shown is today unless the user navigated away, so a session left open across midnight follows the date
  // (the header, the log poll and the instant a quick add lands on all derive from `day`).
  const [picked, setPicked] = useState<string | null>(null)
  const day = picked ?? todayStr
  const setDay = (d: string) => setPicked(d === todayStr ? null : d)
  const log = logState(day).value
  const entries = log.entries.filter((e) => !e.deleted_at)
  const [sheet, setSheet] = useState<SheetState | null>(null)
  const [q, setQ] = useState('')
  const [focused, setFocused] = useState(false)
  const [usda, setUsda] = useState<UsdaState | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const inputRef = useRef<HTMLInputElement>(null)
  const sync = syncState.value

  useEffect(() => { void loadLists() }, [])
  useEffect(() => { void loadLog(day) }, [day])
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') { void loadLog(day); void loadLists() } }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [day])
  useEffect(() => { if (focusSearch) inputRef.current?.focus() }, [focusSearch])
  useEffect(() => { setUsda(null) }, [q])

  const at = () => atFor(day, todayStr, zone)
  const refresh = () => { void loadLists(); void loadLog(day) }

  const logged = (entry: FoodLog) => {
    setSheet(null)
    setQ('')
    toast(`${entry.label} · ${fmtKcal(entry.kcal)} kcal · ${SLOT_LABELS[entry.slot]}`, {
      action: { label: 'Undo', fn: () => { void deleteEntry(entry) } }, duration: 5000,
    })
  }
  const quickLog = async (meal: Meal) => {
    const when = at()
    const entry = await logMeal(meal, 1, slotAt(when, zone), when)
    logged(entry)
  }
  const pickHit = (h: SearchHit) => setSheet(h.kind === 'food' ? { kind: 'food', food: h.food } : { kind: 'meal', meal: h.meal })

  const more = async (type: 'generic' | 'branded' = 'generic') => {
    const query = q.trim()
    if (query.length < 2) return
    setUsda({ q: query, type, loading: true, error: null, candidates: [], demo: false })
    try {
      const r = await searchUSDA(query, type)
      setUsda({ q: query, type, loading: false, error: null, candidates: r.candidates, demo: !!r.demo_key })
    } catch (err) {
      setUsda({ q: query, type, loading: false, error: err instanceof Error ? err.message : 'Search failed', candidates: [], demo: false })
    }
  }
  const ensureFood = async (c: FoodCandidate): Promise<Food> => existingFor(c, foods.value) ?? (await addFood(foodFromCandidate(c)))
  const saveCandidate = async (c: FoodCandidate) => {
    const f = await ensureFood(c)
    toast(`Saved ${f.name}`)
  }
  const logCandidate = async (c: FoodCandidate) => setSheet({ kind: 'food', food: await ensureFood(c) })

  const toggle = (id: string) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }
  const stopSelecting = () => { setSelecting(false); setSelected(new Set()) }

  const hits = focused || q.trim() ? searchLocal(q, foods.value, meals.value, q.trim() ? 20 : 8) : []
  const showSearch = q.trim().length > 0 || focused

  return (
    <>
      <TopBar title="Food" sub={day === todayStr ? dayLabel(day) : undefined} onRefresh={refresh} />
      <main class="content fade food-content">
        {(sync === 'no-token' || sync === 'unauthorized') && (
          <div class="banner banner-danger">
            <span class="grow"><strong>{sync === 'no-token' ? 'No app token yet.' : 'The app token was rejected.'}</strong> Paste it in Settings to load and sync.</span>
            <button type="button" class="btn btn-sm" onClick={() => navigate('#/settings')}>Settings</button>
          </div>
        )}
        <HeaderCard day={day} todayStr={todayStr} entries={entries} onDay={setDay} />

        <section class="card" aria-label="Quick add">
          <div class="card-head">
            <span class="card-title">Quick add</span>
            <a href="#/food/meal" class="small link-row">New meal</a>
          </div>
          <QuickGrid meals={topMeals(meals.value, new Date())} onTap={(m) => void quickLog(m)} onLong={(m) => setSheet({ kind: 'meal', meal: m })} />
          {meals.value.length === 0 && (
            <p class="small muted">{listsLoaded.value ? 'Save a meal and it lands here: tap logs 1x, hold picks a portion.' : listsError.value ? `Meals unavailable: ${listsError.value}` : 'Loading meals…'}</p>
          )}
        </section>

        <section class="card" aria-label="Search">
          <div class="search-row">
            <Icon name="list" size={18} class="faint" />
            <input
              ref={inputRef}
              class="search-input"
              type="search"
              value={q}
              placeholder="Search foods & meals"
              aria-label="Search foods and meals"
              autocomplete="off"
              autocorrect="off"
              enterkeyhint="search"
              onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              onKeyDown={(e) => { if (e.key === 'Enter' && q.trim().length >= 2 && hits.length === 0) void more() }}
            />
            {q && <button type="button" class="icon-btn search-clear" onClick={() => { setQ(''); inputRef.current?.focus() }} aria-label="Clear"><Icon name="x" size={18} /></button>}
          </div>
          {showSearch && (
            <div class="results">
              {hits.map((h) => (
                <button key={`${h.kind}:${h.kind === 'food' ? h.food.id : h.meal.id}`} type="button" class="result-row" onClick={() => pickHit(h)}>
                  <span class="result-main">
                    <span class="result-name">{h.kind === 'food' ? h.food.name : h.meal.name}</span>
                    <span class="result-sub">
                      {h.kind === 'food'
                        ? `${h.food.brand ? `${h.food.brand} · ` : ''}${fmtKcal(h.food.kcal_100)} kcal / 100 g${h.food.serving_text ? ` · ${h.food.serving_text}` : ''}`
                        : `Meal · ${fmtKcal(h.meal.kcal)} kcal · ${fmtNum(h.meal.total_g)} g`}
                    </span>
                  </span>
                  {h.kind === 'food' && showSourceInRow(h.food.source) && <SourceBadge source={h.food.source} />}
                  <span class={`badge${h.kind === 'meal' ? ' badge-warn' : ''}`}>{h.kind === 'meal' ? 'meal' : `${Math.round(h.food.protein_100)}P`}</span>
                </button>
              ))}
              {q.trim().length >= 2 && !usda && (
                <button type="button" class="result-more" onClick={() => void more()}>
                  {hits.length === 0 ? 'Nothing saved yet · ' : ''}More results (USDA) <Icon name="chevron" size={16} />
                </button>
              )}
              {usda && (
                <UsdaResults state={usda} onType={(t) => void more(t)} onSave={(c) => void saveCandidate(c)} onLog={(c) => void logCandidate(c)} />
              )}
            </div>
          )}
          <div class="food-actions">
            <button type="button" class="btn" onClick={() => navigate('#/food/scan')}><ScanGlyph /> Scan</button>
            <button type="button" class="btn" onClick={() => navigate('#/food/label')}><Icon name="tag" size={18} /> Add by label</button>
            <button type="button" class="btn" onClick={() => navigate('#/food/meal')}><Icon name="plus" size={18} /> New meal</button>
          </div>
        </section>

        <LogCard
          day={day}
          todayStr={todayStr}
          entries={entries}
          loading={log.loading && entries.length === 0}
          error={log.error}
          selecting={selecting}
          selected={selected}
          onSelecting={(v) => (v ? setSelecting(true) : stopSelecting())}
          onToggle={toggle}
          onEdit={(e) => setSheet({ kind: 'edit', entry: e })}
          onSaveMeal={() => setSheet({ kind: 'saveMeal', entries: entries.filter((e) => selected.has(e.id)) })}
        />
      </main>

      {sheet?.kind === 'food' && <LogFoodSheet food={sheet.food} at={at()} zone={zone} onDone={logged} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'meal' && <PortionSheet meal={sheet.meal} at={at()} zone={zone} onDone={logged} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'edit' && <EditEntrySheet entry={sheet.entry} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'saveMeal' && (
        <SaveMealSheet entries={sheet.entries} onClose={() => setSheet(null)} onSaved={() => { setSheet(null); stopSelecting() }} />
      )}
    </>
  )
}

function ScanGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 8V5a2 2 0 0 1 2-2h3" /><path d="M16 3h3a2 2 0 0 1 2 2v3" /><path d="M21 16v3a2 2 0 0 1-2 2h-3" /><path d="M8 21H5a2 2 0 0 1-2-2v-3" />
      <path d="M7 8v8" /><path d="M10 8v8" /><path d="M13 8v8" /><path d="M17 8v8" />
    </svg>
  )
}

// ---- header ----------------------------------------------------------------------------------------

function HeaderCard({ day, todayStr, entries, onDay }: { day: string; todayStr: string; entries: FoodLog[]; onDay: (d: string) => void }) {
  const t = settings.value.targets
  const tot = dayTotals(entries)
  const left = t.kcal - tot.kcal
  const pct = t.kcal > 0 ? Math.min(1, tot.kcal / t.kcal) : 0
  const over = tot.kcal > t.kcal
  const isToday = day === todayStr
  return (
    <section class="card food-head" aria-label="Calories and macros">
      <div class="food-daynav">
        <button type="button" class="icon-btn" onClick={() => onDay(addDays(day, -1))} aria-label="Previous day"><Icon name="back" size={20} /></button>
        <button type="button" class="food-daylabel" onClick={() => onDay(todayStr)} disabled={isToday}>
          {isToday ? 'Today' : day === addDays(todayStr, -1) ? 'Yesterday' : dayLabel(day)}
          {!isToday && <span class="small faint"> · back to today</span>}
        </button>
        <button type="button" class="icon-btn" onClick={() => onDay(addDays(day, 1))} aria-label="Next day" disabled={day >= todayStr}><Icon name="chevron" size={20} /></button>
      </div>
      <div class="kcal-line num">
        <span class="kcal-big">{fmtKcal(tot.kcal)}</span>
        <span class="kcal-target"> / {fmtKcal(t.kcal)}</span>
        <span class={`kcal-left${over ? ' over' : ''}`}>{over ? `${fmtKcal(-left)} over` : `${fmtKcal(left)} left`}</span>
      </div>
      <div class={`bar${over ? ' bar-over' : ''}`} role="progressbar" aria-valuenow={Math.round(tot.kcal)} aria-valuemin={0} aria-valuemax={t.kcal} aria-label="Calories">
        <span class="bar-fill" style={`width:${(pct * 100).toFixed(1)}%`} />
      </div>
      <div class="macro-bars">
        <MacroBar label="Protein" short="P" value={tot.protein_g} target={t.protein_g} color="var(--cat-routine)" />
        <MacroBar label="Carbs" short="C" value={tot.carb_g} target={t.carb_g} color="var(--cat-meal)" />
        <MacroBar label="Fat" short="F" value={tot.fat_g} target={t.fat_g} color="var(--cat-workout)" />
      </div>
    </section>
  )
}

function MacroBar({ label, short, value, target, color }: { label: string; short: string; value: number; target: number; color: string }) {
  const pct = target > 0 ? Math.min(1, value / target) : 0
  return (
    <div class="macro" aria-label={`${label} ${Math.round(value)} of ${target} g`}>
      <div class="macro-head num"><span class="macro-name">{short}</span><span>{Math.round(value)}<span class="faint"> / {target} g</span></span></div>
      <div class="bar bar-thin"><span class="bar-fill" style={`width:${(pct * 100).toFixed(1)}%;background:${color}`} /></div>
    </div>
  )
}

// ---- quick add -------------------------------------------------------------------------------------

function QuickGrid({ meals: list, onTap, onLong }: { meals: Meal[]; onTap: (m: Meal) => void; onLong: (m: Meal) => void }) {
  if (list.length === 0) return null
  return (
    <div class="quick-grid">
      {list.map((m) => <QuickTile key={m.id} meal={m} onTap={() => onTap(m)} onLong={() => onLong(m)} />)}
    </div>
  )
}

function QuickTile({ meal, onTap, onLong }: { meal: Meal; onTap: () => void; onLong: () => void }) {
  const press = useLongPress(onTap, onLong)
  return (
    <button type="button" class="quick-tile" title={`${meal.name}: tap logs 1x, hold for a portion`} {...press}>
      <span class="quick-name">{meal.name}</span>
      <span class="quick-kcal num">{fmtKcal(meal.kcal)} kcal</span>
    </button>
  )
}

// ---- USDA results ----------------------------------------------------------------------------------

function UsdaResults({ state, onType, onSave, onLog }: { state: UsdaState; onType: (t: 'generic' | 'branded') => void; onSave: (c: FoodCandidate) => void; onLog: (c: FoodCandidate) => void }) {
  return (
    <div class="usda">
      <div class="row usda-head">
        <span class="small faint">USDA · “{state.q}”</span>
        <span class="grow" />
        <div class="seg" role="group" aria-label="USDA type">
          <button type="button" aria-pressed={state.type === 'generic'} onClick={() => onType('generic')}>Generic</button>
          <button type="button" aria-pressed={state.type === 'branded'} onClick={() => onType('branded')}>Branded</button>
        </div>
      </div>
      {state.loading && <p class="small muted">Searching USDA…</p>}
      {state.error && <p class="small" style="color: var(--danger)">{state.error}</p>}
      {!state.loading && !state.error && state.candidates.length === 0 && <p class="small muted">No USDA matches.</p>}
      {state.demo && <p class="small faint">Using USDA’s shared DEMO_KEY (rate-limited). Set USDA_KEY on the Worker for your own quota.</p>}
      {state.candidates.map((c) => (
        <div key={c.source_id} class="cand-row">
          <span class="result-main">
            <span class="result-name">{c.name}</span>
            <span class="result-sub">{c.brand ? `${c.brand} · ` : ''}{fmtKcal(c.kcal_100)} kcal / 100 g · {fmtNum(c.protein_100)}P {fmtNum(c.carb_100)}C {fmtNum(c.fat_100)}F{c.serving_text ? ` · ${c.serving_text}` : ''}{c.complete ? '' : ' · incomplete'}</span>
          </span>
          <span class="cand-actions">
            <button type="button" class="btn btn-sm" onClick={() => onSave(c)}>Save</button>
            <button type="button" class="btn btn-sm btn-primary" onClick={() => onLog(c)}>Log now</button>
          </span>
        </div>
      ))}
    </div>
  )
}

// ---- log list --------------------------------------------------------------------------------------

function LogCard({ day, todayStr, entries, loading, error, selecting, selected, onSelecting, onToggle, onEdit, onSaveMeal }: {
  day: string
  todayStr: string
  entries: FoodLog[]
  loading: boolean
  error: string | null
  selecting: boolean
  selected: ReadonlySet<string>
  onSelecting: (v: boolean) => void
  onToggle: (id: string) => void
  onEdit: (e: FoodLog) => void
  onSaveMeal: () => void
}) {
  const groups = groupBySlot(entries)
  return (
    <section class="card" aria-label="Food log">
      <div class="card-head">
        <span class="card-title">{day === todayStr ? 'Today' : dayLabel(day)} · {entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>
        {entries.length > 0 && (
          <button type="button" class="btn btn-sm btn-ghost" onClick={() => onSelecting(!selecting)}>{selecting ? 'Done' : 'Select'}</button>
        )}
      </div>
      {entries.length === 0 && <p class="small muted">{loading ? 'Loading the log…' : error ? `Log unavailable: ${error}` : 'Nothing logged yet. Tap a meal above or search for a food.'}</p>}
      {groups.map((g) => (
        <div key={g.slot} class="log-group">
          <div class="log-slot num">
            <span>{SLOT_LABELS[g.slot]}</span>
            <span class="faint">{fmtKcal(g.totals.kcal)} kcal · {Math.round(g.totals.protein_g)}P {Math.round(g.totals.carb_g)}C {Math.round(g.totals.fat_g)}F</span>
          </div>
          {g.entries.map((e) => (
            <button
              key={e.id}
              type="button"
              class="log-row"
              aria-pressed={selecting ? selected.has(e.id) : undefined}
              onClick={() => (selecting ? onToggle(e.id) : onEdit(e))}
            >
              {selecting && <span class={`log-check${selected.has(e.id) ? ' on' : ''}`}>{selected.has(e.id) && <Icon name="check" size={14} stroke={2.5} />}</span>}
              <span class="result-main">
                <span class="result-name">{e.label}{e.meal_id && <span class="faint small"> · meal</span>}</span>
                <span class="result-sub">{entryDetail(e)}{e.note ? ` · ${e.note}` : ''}</span>
              </span>
              {!selecting && <Icon name="chevron" size={16} class="faint" />}
            </button>
          ))}
        </div>
      ))}
      {selecting && (
        <button type="button" class="btn btn-primary btn-block" style="margin-top: 10px" disabled={selected.size === 0} onClick={onSaveMeal}>
          <Icon name="plus" size={18} /> Save as meal{selected.size ? ` (${selected.size})` : ''}
        </button>
      )}
    </section>
  )
}

function EditEntrySheet({ entry, onClose }: { entry: FoodLog; onClose: () => void }) {
  const isFood = !!entry.food_id
  const food = isFood ? foods.value.find((f) => f.id === entry.food_id) ?? null : null
  const [amount, setAmount] = useState(isFood ? entry.grams ?? 0 : entry.scale ?? 1)
  const [slot, setSlot] = useState<Slot>(entry.slot)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!(amount > 0)) { toast(isFood ? 'Enter the grams' : 'Enter the portion', { kind: 'danger' }); return }
    setBusy(true)
    try {
      const next = await editEntry(entry, { amount, slot })
      toast(`${next.label} · ${entryDetail(next)}`)
      onClose()
    } finally { setBusy(false) }
  }
  // Delete is a tombstone through the outbox; Undo re-queues the same row with deleted_at cleared and a newer
  // updated_at, so it wins over the tombstone on the server too.
  const del = async () => {
    await deleteEntry(entry)
    toast(`${entry.label} removed`, { action: { label: 'Undo', fn: () => { void restoreEntry(entry) } }, duration: 5000 })
    onClose()
  }
  // Per-100 g profile for the live kcal: the cached food, or the entry's own snapshot scaled back to 100 g.
  const per100 = food ?? {
    kcal_100: entry.grams ? (entry.kcal * 100) / entry.grams : 0, protein_100: entry.grams ? (entry.protein_g * 100) / entry.grams : 0,
    carb_100: entry.grams ? (entry.carb_g * 100) / entry.grams : 0, fat_100: entry.grams ? (entry.fat_g * 100) / entry.grams : 0,
    fiber_100: null, sugar_100: null, serving_g: null,
  }
  return (
    <Sheet title={entry.label} sub={`${entryDetail(entry)} · ${SLOT_LABELS[entry.slot]}`} onClose={onClose}>
      <div class="stack">
        {food && <div class="sheet-source"><SourceBadge source={food.source} /></div>}
        {isFood ? (
          <GramsPad food={per100} grams={amount} onChange={setAmount} />
        ) : (
          <div class="field">
            <label for="edit-scale">Portion (x)</label>
            <div class="row">
              <input id="edit-scale" class="grams-input num" type="number" inputMode="decimal" min={0} step="any" value={String(amount)} onInput={(e) => setAmount(Number((e.currentTarget as HTMLInputElement).value))} />
              <span class="small muted">x · {fmtKcal((entry.kcal / (entry.scale || 1)) * (amount || 0))} kcal</span>
            </div>
          </div>
        )}
        <SlotChips value={slot} onChange={setSlot} />
        <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => void save()} disabled={busy}><Icon name="check" size={20} /> Save</button>
        <button type="button" class="btn btn-danger btn-block" onClick={() => void del()}><Icon name="trash" size={18} /> Delete entry</button>
      </div>
    </Sheet>
  )
}

function SaveMealSheet({ entries, onClose, onSaved }: { entries: FoodLog[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [slot, setSlot] = useState<Slot>(entries[0]?.slot ?? 'lunch')
  const [busy, setBusy] = useState(false)
  const tot = dayTotals(entries)
  const save = async () => {
    if (!name.trim()) { toast('Name the meal', { kind: 'danger' }); return }
    setBusy(true)
    try {
      const m = await saveAsMeal(entries, name.trim(), slot)
      toast(`Saved meal ${m.name} · ${fmtKcal(m.kcal)} kcal`)
      onSaved()
    } finally { setBusy(false) }
  }
  return (
    <Sheet title="Save as meal" sub={`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} · ${fmtKcal(tot.kcal)} kcal · ${Math.round(tot.protein_g)}P ${Math.round(tot.carb_g)}C ${Math.round(tot.fat_g)}F`} onClose={onClose}>
      <div class="stack">
        <div class="field">
          <label for="meal-name">Name</label>
          <input id="meal-name" type="text" value={name} placeholder="e.g. Oats bowl" autofocus onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} enterkeyhint="done" />
        </div>
        <div class="field"><span class="label">Default slot</span><SlotChips value={slot} onChange={setSlot} /></div>
        <ul class="small muted meal-preview">{entries.map((e) => <li key={e.id}>{e.label} · {entryDetail(e)}</li>)}</ul>
        <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => void save()} disabled={busy}><Icon name="check" size={20} /> Save meal</button>
      </div>
    </Sheet>
  )
}
