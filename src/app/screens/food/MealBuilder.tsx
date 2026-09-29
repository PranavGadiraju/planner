// Meal builder ('#/food/meal' new, '#/food/meal/<id>' edit): name, default slot, items (food + grams) with running
// totals at 1x, add via local search + grams pad, remove, reorder, Duplicate, Delete (tombstone; logged rows keep
// their snapshots).
import { useEffect, useState } from 'preact/hooks'
import type { Food, Slot } from '@shared/types'
import { SubBar } from '../../components/TopBar'
import { Sheet } from '../../components/Sheet'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { navigate } from '../../router'
import {
  computeMeal, deleteMeal, duplicateMeal, fmtKcal, fmtNum, foodSnapshot, foods, listsLoaded, loadLists, mealItems, meals, saveMeal, searchLocal, type MealItemInput,
} from '../../data/food'
import { GramsPad, SlotChips, SourceBadge, showSourceInRow } from './common'

export function MealBuilder({ id }: { id: string | null }) {
  const existing = id ? meals.value.find((m) => m.id === id) ?? null : null
  const [name, setName] = useState('')
  const [slot, setSlot] = useState<Slot | null>(null)
  const [items, setItems] = useState<MealItemInput[]>([])
  const [seeded, setSeeded] = useState(!id)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState<Food | null>(null)

  useEffect(() => { void loadLists() }, [])
  // Seed the form once the meal (and its items) are in the cache; never overwrite what the user already typed.
  useEffect(() => {
    if (seeded || dirty || !existing) return
    setName(existing.name)
    setSlot(existing.default_slot)
    setItems(mealItems.value.filter((i) => i.meal_id === existing.id && !i.deleted_at).sort((a, b) => a.position - b.position).map((i) => ({ food_id: i.food_id, grams: i.grams })))
    setSeeded(true)
  }, [existing, seeded, dirty, mealItems.value])

  const byId = new Map(foods.value.map((f) => [f.id, f]))
  const calc = computeMeal(items, foods.value)
  const touch = () => setDirty(true)
  const setGrams = (idx: number, g: number) => { setItems((l) => l.map((it, i) => (i === idx ? { ...it, grams: g } : it))); touch() }
  const remove = (idx: number) => { setItems((l) => l.filter((_, i) => i !== idx)); touch() }
  const move = (idx: number, dir: -1 | 1) => {
    setItems((l) => {
      const j = idx + dir
      if (j < 0 || j >= l.length) return l
      const next = l.slice()
      const a = next[idx], b = next[j]
      if (!a || !b) return l
      next[idx] = b
      next[j] = a
      return next
    })
    touch()
  }
  const add = (food: Food, grams: number) => { setItems((l) => [...l, { food_id: food.id, grams }]); setAdding(null); setQ(''); touch() }

  const save = async () => {
    if (!name.trim()) { toast('Name the meal', { kind: 'danger' }); return }
    if (items.length === 0 || items.some((i) => !(i.grams > 0))) { toast('Every item needs grams', { kind: 'danger' }); return }
    setBusy(true)
    try {
      const m = await saveMeal({ id: existing?.id, name: name.trim(), default_slot: slot, items })
      toast(`${existing ? 'Updated' : 'Saved'} ${m.name} · ${fmtKcal(m.kcal)} kcal`)
      setDirty(false)
      navigate('#/food')
    } finally { setBusy(false) }
  }
  const dup = async () => {
    if (!existing) return
    const m = await duplicateMeal(existing)
    toast(`Duplicated as ${m.name}`)
    navigate(`#/food/meal/${m.id}`)
  }
  const del = async () => {
    if (!existing) return
    if (!confirm(`Delete "${existing.name}"? Past log entries keep their numbers.`)) return
    await deleteMeal(existing)
    toast(`${existing.name} deleted`)
    navigate('#/food')
  }

  const hits = q.trim() ? searchLocal(q, foods.value, [], 12) : []
  const missingMeal = !!id && listsLoaded.value && !existing

  return (
    <>
      <SubBar
        title={existing ? 'Edit meal' : 'New meal'}
        fallback="#/food"
        right={<button type="button" class="btn btn-sm btn-primary" onClick={() => void save()} disabled={busy || (!!existing && !dirty)}>Save</button>}
      />
      <main class="content fade">
        {missingMeal &&<div class="banner banner-danger"><span class="grow small">This meal is not in the cache (deleted, or not synced yet).</span></div>}
        <section class="card">
          <div class="stack-sm">
            <input type="text" value={name} placeholder="Meal name" aria-label="Meal name" onInput={(e) => { setName((e.currentTarget as HTMLInputElement).value); touch() }} />
            <div class="field">
              <span class="label">Default slot <span class="faint">(one-tap logs use the time of day when unset)</span></span>
              <SlotChips value={slot} onChange={(s) => { setSlot(slot === s ? null : s); touch() }} />
            </div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <span class="card-title">Items · 1x</span>
            <span class="small faint num">{fmtNum(calc.total_g)} g</span>
          </div>
          {items.length === 0 && <p class="small muted">No items yet. Search below to add foods.</p>}
          <div class="list">
            {items.map((it, idx) => {
              const f = byId.get(it.food_id)
              const m = f ? foodSnapshot(f, it.grams) : null
              return (
                <div key={`${it.food_id}-${idx}`} class="meal-item">
                  <span class="result-main">
                    <span class="result-name">{f?.name ?? 'Unknown food'}</span>
                    <span class="result-sub num">{m ? `${fmtKcal(m.kcal)} kcal · ${Math.round(m.protein_g)}P ${Math.round(m.carb_g)}C ${Math.round(m.fat_g)}F` : 'not in the cache'}</span>
                  </span>
                  <input class="meal-grams num" type="number" inputMode="decimal" min={0} step="any" value={it.grams > 0 ? String(it.grams) : ''} aria-label={`Grams of ${f?.name ?? 'item'}`} onInput={(e) => setGrams(idx, Number((e.currentTarget as HTMLInputElement).value))} />
                  <span class="small faint">g</span>
                  <span class="meal-item-btns">
                    <button type="button" class="icon-btn" onClick={() => move(idx, -1)} disabled={idx === 0} aria-label="Move up"><Icon name="up" size={16} /></button>
                    <button type="button" class="icon-btn" onClick={() => move(idx, 1)} disabled={idx === items.length - 1} aria-label="Move down"><Icon name="down" size={16} /></button>
                    <button type="button" class="icon-btn" onClick={() => remove(idx)} aria-label="Remove"><Icon name="x" size={16} /></button>
                  </span>
                </div>
              )
            })}
          </div>
          <div class="meal-totals num">
            <span class="kcal-big">{fmtKcal(calc.totals.kcal)}</span><span class="muted"> kcal</span>
            <span class="faint"> · {Math.round(calc.totals.protein_g)}P {Math.round(calc.totals.carb_g)}C {Math.round(calc.totals.fat_g)}F{calc.totals.fiber_g != null ? ` · ${Math.round(calc.totals.fiber_g)} fiber` : ''}</span>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><span class="card-title">Add item</span></div>
          <input type="search" value={q} placeholder="Search saved foods" aria-label="Search foods" autocomplete="off" enterkeyhint="search" onInput={(e) => setQ((e.currentTarget as HTMLInputElement).value)} />
          {q.trim() && (
            <div class="results">
              {hits.length === 0 && <p class="small muted" style="padding: 8px 0 0">Nothing saved matches. <a href="#/food/search">Search USDA</a> or <a href="#/food/label">add by label</a> first.</p>}
              {hits.map((h) => h.kind === 'food' && (
                <button key={h.food.id} type="button" class="result-row" onClick={() => setAdding(h.food)}>
                  <span class="result-main">
                    <span class="result-name">{h.food.name}</span>
                    <span class="result-sub">{h.food.brand ? `${h.food.brand} · ` : ''}{fmtKcal(h.food.kcal_100)} kcal / 100 g</span>
                  </span>
                  {showSourceInRow(h.food.source) && <SourceBadge source={h.food.source} />}
                  <Icon name="plus" size={18} class="faint" />
                </button>
              ))}
            </div>
          )}
        </section>

        <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => void save()} disabled={busy}><Icon name="check" size={20} /> {existing ? 'Save changes' : 'Save meal'}</button>
        {existing && (
          <div class="grid-2">
            <button type="button" class="btn" onClick={() => void dup()}><Icon name="copy" size={18} /> Duplicate</button>
            <button type="button" class="btn btn-danger" onClick={() => void del()}><Icon name="trash" size={18} /> Delete</button>
          </div>
        )}
      </main>
      {adding && <AddItemSheet food={adding} onAdd={(g) => add(adding, g)} onClose={() => setAdding(null)} />}
    </>
  )
}

function AddItemSheet({ food, onAdd, onClose }: { food: Food; onAdd: (grams: number) => void; onClose: () => void }) {
  const [grams, setGrams] = useState(food.serving_g && food.serving_g > 0 ? food.serving_g : 100)
  return (
    <Sheet title={food.name} sub={`${food.brand ? `${food.brand} · ` : ''}${fmtKcal(food.kcal_100)} kcal / 100 g`} onClose={onClose}>
      <div class="stack">
        <div class="sheet-source"><SourceBadge source={food.source} /></div>
        <GramsPad food={food} grams={grams} onChange={setGrams} />
        <button type="button" class="btn btn-primary btn-big btn-block" disabled={!(grams > 0)} onClick={() => onAdd(grams)}><Icon name="plus" size={20} /> Add {grams > 0 ? `${fmtNum(grams)} g` : ''}</button>
      </div>
    </Sheet>
  )
}
