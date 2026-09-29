// Food state: foods, meals (+ items) and the per-day log as signals, network-first loaders with an IndexedDB
// fallback (the kitchen has poor signal), local search over the cached lists, and the write helpers. Every write
// builds a full row, patches the local signals at once (optimistic) and goes through the outbox; the food_log row
// snapshots kcal/macros so later edits of a food or meal never rewrite history.
import { batch, signal, type Signal } from '@preact/signals'
import { get, set } from 'idb-keyval'
import type { Food, FoodLog, Meal, MealItem, Slot } from '@shared/types'
import { mealTotals, per100FromServing, scalePer100, sumMacros, type Macros, type Per100 } from '@shared/nutrition'
import { OFF_PRODUCT_URL, candidateFromOFF, inferSlot, type FoodCandidate } from '@shared/lookup'
import { localDay, localParts } from '@shared/tz'
import { ApiError, apiGet, hasToken, readCache } from './api'
import * as outbox from './outbox'
import { tz } from './store'
import { uuid } from './format'

export const SLOTS: readonly Slot[] = ['breakfast', 'lunch', 'dinner', 'snack']
export const SLOT_LABELS: Record<Slot, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks' }

const r1 = (n: number) => Math.round(n * 10) / 10
const nowIso = () => new Date().toISOString()

// ---- state --------------------------------------------------------------------------------------------

/** Live (non-deleted) foods, most used first. */
export const foods = signal<Food[]>([])
/** Live meals, most used first, and their live items. */
export const meals = signal<Meal[]>([])
export const mealItems = signal<MealItem[]>([])
export const listsLoaded = signal(false)
export const listsError = signal<string | null>(null)

export interface LogDayState { day: string; entries: FoodLog[]; loading: boolean; error: string | null; fetchedAt: string | null; cached: boolean }
const logStates = new Map<string, Signal<LogDayState>>()

/** The log state signal for a local day (created empty on first use). */
export function logState(day: string): Signal<LogDayState> {
  let s = logStates.get(day)
  if (!s) {
    s = signal<LogDayState>({ day, entries: [], loading: false, error: null, fetchedAt: null, cached: false })
    logStates.set(day, s)
  }
  return s
}

type Synced = { id: string; updated_at: string; deleted_at: string | null }

/** Merge rows into a list by id (newest updated_at wins); tombstones fall out. */
export function mergeRows<T extends Synced>(cur: readonly T[], rows: readonly T[]): T[] {
  const map = new Map(cur.map((r) => [r.id, r]))
  for (const r of rows) {
    const prev = map.get(r.id)
    if (!prev || r.updated_at >= prev.updated_at) map.set(r.id, r)
  }
  return [...map.values()].filter((r) => !r.deleted_at)
}

export function byUse<T extends { use_count: number; last_used_at: string | null; name: string }>(a: T, b: T): number {
  if (b.use_count !== a.use_count) return b.use_count - a.use_count
  const la = a.last_used_at ?? '', lb = b.last_used_at ?? ''
  if (la !== lb) return lb < la ? -1 : 1
  return a.name.localeCompare(b.name)
}

/** Mirror one queued row into the local signals (idempotent, so replaying the queue is safe). */
export function applyLocal(table: string, row: Record<string, unknown>): void {
  switch (table) {
    case 'foods':
      foods.value = mergeRows(foods.value, [row as unknown as Food]).sort(byUse)
      return
    case 'meals':
      meals.value = mergeRows(meals.value, [row as unknown as Meal]).sort(byUse)
      return
    case 'meal_items':
      mealItems.value = mergeRows(mealItems.value, [row as unknown as MealItem]).sort((a, b) => a.position - b.position)
      return
    case 'food_log': {
      const r = row as unknown as FoodLog
      if (typeof r.local_day !== 'string') return
      const s = logState(r.local_day)
      s.value = { ...s.value, entries: mergeRows(s.value.entries, [r]).sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)) }
      return
    }
    default:
      return
  }
}
outbox.onEnqueue(applyLocal)

// ---- loading ------------------------------------------------------------------------------------------

interface FoodsPayload { foods: Food[] }
interface MealsPayload { meals: Meal[]; items: MealItem[] }
export interface LogPayload { day: string; entries: FoodLog[]; totals: Macros; by_slot: Record<string, Macros> }

const inflight = new Map<string, Promise<void>>()
function once(key: string, fn: () => Promise<void>): Promise<void> {
  const cur = inflight.get(key)
  if (cur) return cur
  const p = fn().finally(() => { inflight.delete(key) })
  inflight.set(key, p)
  return p
}

async function replayQueue(tables: readonly string[]): Promise<void> {
  const queued = await outbox.peek()
  batch(() => { for (const it of queued) if (tables.includes(it.table)) applyLocal(it.table, it.row) })
}

/** Fetch foods + meals (cache fallback) and replay queued rows on top. */
export function loadLists(): Promise<void> {
  return once('lists', async () => {
    const useCache = !hasToken()
    try {
      const [f, m] = useCache
        ? [await readCache<FoodsPayload>('foods'), await readCache<MealsPayload>('meals')]
        : await Promise.all([apiGet<FoodsPayload>('/api/foods?limit=1000', 'foods'), apiGet<MealsPayload>('/api/meals', 'meals')])
      batch(() => {
        if (f) foods.value = mergeRows([], f.data.foods).sort(byUse)
        if (m) {
          meals.value = mergeRows([], m.data.meals).sort(byUse)
          mealItems.value = mergeRows([], m.data.items).sort((a, b) => a.position - b.position)
        }
      })
      listsError.value = null
      if (f || m) listsLoaded.value = true
    } catch (err) {
      listsError.value = err instanceof ApiError ? err.message : 'Cannot reach the server'
      if (!listsLoaded.value) {
        const f = await readCache<FoodsPayload>('foods')
        const m = await readCache<MealsPayload>('meals')
        batch(() => {
          if (f) foods.value = mergeRows([], f.data.foods).sort(byUse)
          if (m) { meals.value = mergeRows([], m.data.meals).sort(byUse); mealItems.value = mergeRows([], m.data.items) }
        })
        if (f || m) listsLoaded.value = true
      }
    }
    await replayQueue(['foods', 'meals', 'meal_items'])
  })
}

/** Fetch one day's log (cache fallback) and replay queued entries for that day on top. */
export function loadLog(day: string): Promise<void> {
  return once(`log:${day}`, async () => {
    const s = logState(day)
    const key = `food-log:${day}`
    if (!hasToken()) {
      const hit = await readCache<LogPayload>(key)
      if (hit) s.value = { ...s.value, entries: hit.data.entries, fetchedAt: hit.fetchedAt, cached: true }
      await replayQueue(['food_log'])
      return
    }
    s.value = { ...s.value, loading: true }
    try {
      const r = await apiGet<LogPayload>(`/api/food-log?day=${day}`, key)
      const cur = s.value
      if (!(r.cached && cur.fetchedAt && r.fetchedAt <= cur.fetchedAt)) {
        s.value = { ...cur, entries: r.data.entries, fetchedAt: r.fetchedAt, cached: r.cached, error: null }
      } else s.value = { ...cur, error: null }
    } catch (err) {
      s.value = { ...s.value, error: err instanceof ApiError ? err.message : 'Cannot reach the server' }
    } finally {
      s.value = { ...s.value, loading: false }
    }
    await replayQueue(['food_log'])
  })
}

// After a flush the server is the truth again: refresh what the batch touched.
outbox.onFlushed((items) => {
  let lists = false
  const days = new Set<string>()
  for (const it of items) {
    if (it.table === 'foods' || it.table === 'meals' || it.table === 'meal_items') lists = true
    if (it.table === 'food_log' && typeof it.row['local_day'] === 'string') days.add(it.row['local_day'] as string)
  }
  if (lists && listsLoaded.value) void loadLists()
  for (const d of days) if (logStates.has(d)) void loadLog(d)
})

// ---- pure helpers (unit-tested) -----------------------------------------------------------------------

export type SearchHit = { kind: 'food'; food: Food; score: number } | { kind: 'meal'; meal: Meal; score: number }

function matchScore(q: string, name: string, brand: string | null): number {
  const n = name.toLowerCase(), b = (brand ?? '').toLowerCase()
  if (n === q) return 5
  if (n.startsWith(q)) return 4
  if (n.split(/\s+/).some((w) => w.startsWith(q))) return 3
  if (n.includes(q)) return 2
  if (b.includes(q)) return 1
  return 0
}

/**
 * Local search over cached foods and meals: substring on name/brand, better matches first, then the most used.
 * An empty query lists the most used items (meals first) so the row is useful before typing.
 */
export function searchLocal(query: string, foodList: readonly Food[], mealList: readonly Meal[], limit = 20): SearchHit[] {
  const q = query.trim().toLowerCase()
  const hits: SearchHit[] = []
  for (const m of mealList) {
    const s = q ? matchScore(q, m.name, null) : 1
    if (s > 0) hits.push({ kind: 'meal', meal: m, score: s + 0.5 })
  }
  for (const f of foodList) {
    const s = q ? matchScore(q, f.name, f.brand) : 1
    if (s > 0) hits.push({ kind: 'food', food: f, score: s })
  }
  const useOf = (h: SearchHit) => (h.kind === 'food' ? h.food : h.meal)
  hits.sort((a, b) => b.score - a.score || byUse(useOf(a), useOf(b)))
  return hits.slice(0, limit)
}

/** Top meals for the quick-add grid: use_count weighted by recency (a meal untouched for a month counts a third). */
export function topMeals(list: readonly Meal[], now: Date, n = 6): Meal[] {
  const score = (m: Meal) => {
    const days = m.last_used_at ? Math.max(0, (now.getTime() - new Date(m.last_used_at).getTime()) / 86400_000) : 60
    return (m.use_count + 1) / (1 + days / 15)
  }
  return [...list].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name)).slice(0, n)
}

export function foodSnapshot(food: Per100, grams: number): Macros {
  return scalePer100(food, grams)
}
export function mealSnapshot(meal: Pick<Meal, 'kcal' | 'protein_g' | 'carb_g' | 'fat_g' | 'fiber_g' | 'sugar_g'>, scale: number): Macros {
  return {
    kcal: r1(meal.kcal * scale), protein_g: r1(meal.protein_g * scale), carb_g: r1(meal.carb_g * scale), fat_g: r1(meal.fat_g * scale),
    fiber_g: meal.fiber_g == null ? null : r1(meal.fiber_g * scale), sugar_g: meal.sugar_g == null ? null : r1(meal.sugar_g * scale),
  }
}

/** Scale an existing snapshot proportionally (used when the source food/meal is not cached locally). */
export function scaleSnapshot(e: Macros, factor: number): Macros {
  return {
    kcal: r1(e.kcal * factor), protein_g: r1(e.protein_g * factor), carb_g: r1(e.carb_g * factor), fat_g: r1(e.fat_g * factor),
    fiber_g: e.fiber_g == null ? null : r1(e.fiber_g * factor), sugar_g: e.sugar_g == null ? null : r1(e.sugar_g * factor),
  }
}

export interface EntryInput { at: Date; slot: Slot; tz: string; note?: string | null }

export function buildFoodEntry(food: Food, grams: number, input: EntryInput): FoodLog {
  const m = foodSnapshot(food, grams)
  const ts = nowIso()
  return {
    id: uuid(), ts: input.at.toISOString(), local_day: localDay(input.at, input.tz), slot: input.slot,
    food_id: food.id, meal_id: null, grams: r1(grams), scale: null, label: food.name,
    kcal: m.kcal, protein_g: m.protein_g, carb_g: m.carb_g, fat_g: m.fat_g, fiber_g: m.fiber_g ?? null, sugar_g: m.sugar_g ?? null,
    note: input.note ?? null, source: 'app', created_at: ts, updated_at: ts, deleted_at: null,
  }
}

export function buildMealEntry(meal: Meal, scale: number, input: EntryInput): FoodLog {
  const m = mealSnapshot(meal, scale)
  const ts = nowIso()
  return {
    id: uuid(), ts: input.at.toISOString(), local_day: localDay(input.at, input.tz), slot: input.slot,
    food_id: null, meal_id: meal.id, grams: null, scale: r1(scale * 100) / 100, label: meal.name,
    kcal: m.kcal, protein_g: m.protein_g, carb_g: m.carb_g, fat_g: m.fat_g, fiber_g: m.fiber_g ?? null, sugar_g: m.sugar_g ?? null,
    note: input.note ?? null, source: 'app', created_at: ts, updated_at: ts, deleted_at: null,
  }
}

/** Re-snapshot an entry for new grams (food) or scale (meal); falls back to proportional scaling without the source row. */
export function recomputeEntry(entry: FoodLog, amount: number, source: Food | Meal | null): FoodLog {
  let m: Macros
  if (entry.food_id) {
    m = source && 'kcal_100' in source ? foodSnapshot(source, amount) : scaleSnapshot(entry, entry.grams ? amount / entry.grams : 1)
    return { ...entry, grams: r1(amount), ...macroCols(m) }
  }
  m = source && 'total_g' in source ? mealSnapshot(source, amount) : scaleSnapshot(entry, entry.scale ? amount / entry.scale : 1)
  return { ...entry, scale: r1(amount * 100) / 100, ...macroCols(m) }
}
function macroCols(m: Macros): Pick<FoodLog, 'kcal' | 'protein_g' | 'carb_g' | 'fat_g' | 'fiber_g' | 'sugar_g'> {
  return { kcal: m.kcal, protein_g: m.protein_g, carb_g: m.carb_g, fat_g: m.fat_g, fiber_g: m.fiber_g ?? null, sugar_g: m.sugar_g ?? null }
}

export function dayTotals(entries: readonly FoodLog[]): Macros {
  return sumMacros(entries.filter((e) => !e.deleted_at))
}

export interface SlotGroup { slot: Slot; entries: FoodLog[]; totals: Macros }
/** Entries grouped in slot order (only slots with entries), each with its subtotal. */
export function groupBySlot(entries: readonly FoodLog[]): SlotGroup[] {
  const out: SlotGroup[] = []
  for (const slot of SLOTS) {
    const list = entries.filter((e) => e.slot === slot && !e.deleted_at)
    if (list.length) out.push({ slot, entries: list, totals: sumMacros(list) })
  }
  return out
}

/** "180 g · 190 kcal · 18P" / "1.5x · 780 kcal · 36P". */
export function entryDetail(e: FoodLog): string {
  const amount = e.food_id ? `${fmtNum(e.grams ?? 0)} g` : `${fmtNum(e.scale ?? 1)}x`
  return `${amount} · ${fmtKcal(e.kcal)} kcal · ${Math.round(e.protein_g)}P`
}

export function fmtKcal(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}
export function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(r1(n))
}

/** The slot for an instant in tz (used by one-tap logging). */
export function slotAt(at: Date, zone: string): Slot {
  const p = localParts(at, zone)
  return inferSlot(p.h, p.mi)
}

export interface MealItemInput { food_id: string; grams: number }
export interface MealCalc { total_g: number; totals: Macros; per100: Per100; missing: string[] }

/** Totals at 1x for a list of items; foods not in the cache are reported in `missing` and contribute nothing. */
export function computeMeal(items: readonly MealItemInput[], foodList: readonly Food[]): MealCalc {
  const byId = new Map(foodList.map((f) => [f.id, f]))
  const missing: string[] = []
  const rows: { per100: Per100; grams: number }[] = []
  for (const it of items) {
    const f = byId.get(it.food_id)
    if (!f) { missing.push(it.food_id); continue }
    rows.push({ per100: f, grams: it.grams })
  }
  const t = mealTotals(rows)
  return { ...t, missing }
}

/** Flatten logged entries into meal items: a food entry is one item, a meal entry expands to its items x scale. */
export function itemsFromEntries(entries: readonly FoodLog[], items: readonly MealItem[]): MealItemInput[] {
  const out: MealItemInput[] = []
  for (const e of entries) {
    if (e.food_id) out.push({ food_id: e.food_id, grams: e.grams ?? 0 })
    else if (e.meal_id) {
      const scale = e.scale ?? 1
      for (const it of items.filter((i) => i.meal_id === e.meal_id && !i.deleted_at)) out.push({ food_id: it.food_id, grams: r1(it.grams * scale) })
    }
  }
  return out
}

// ---- label form -------------------------------------------------------------------------------------

export type LabelMode = 'serving' | 'per100'
export interface LabelForm {
  name: string; brand: string; mode: LabelMode; serving_g: string; serving_text: string
  kcal: string; protein: string; carb: string; fat: string; fiber: string; sugar: string
}
export const EMPTY_LABEL_FORM: LabelForm = { name: '', brand: '', mode: 'serving', serving_g: '', serving_text: '', kcal: '', protein: '', carb: '', fat: '', fiber: '', sugar: '' }

const formNum = (s: string): number => { const n = Number(s); return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : 0 }
const formOpt = (s: string): number | null => (s.trim() === '' ? null : formNum(s))

/** The per-100 g profile a label form describes (+ the numbers as typed, for the 4/4/9 check), or null while the serving grams are missing in per-serving mode. */
export function labelPer100(f: LabelForm): { per100: Per100; basis: Macros; serving_g: number | null } | null {
  const basis: Macros = { kcal: formNum(f.kcal), protein_g: formNum(f.protein), carb_g: formNum(f.carb), fat_g: formNum(f.fat), fiber_g: formOpt(f.fiber), sugar_g: formOpt(f.sugar) }
  const serving_g = formNum(f.serving_g) > 0 ? formNum(f.serving_g) : null
  if (f.mode === 'per100') {
    return {
      per100: { kcal_100: basis.kcal, protein_100: basis.protein_g, carb_100: basis.carb_g, fat_100: basis.fat_g, fiber_100: basis.fiber_g ?? null, sugar_100: basis.sugar_g ?? null },
      basis, serving_g,
    }
  }
  if (serving_g === null) return null
  return { per100: per100FromServing(basis, serving_g), basis, serving_g }
}

/** A candidate (OFF / USDA) or label form -> the fields of a new foods row. */
export interface NewFood {
  name: string
  brand: string | null
  source: Food['source']
  source_id: string | null
  per100: Per100
  serving_g: number | null
  serving_text: string | null
  label_json?: string | null
}

export function foodFromCandidate(c: FoodCandidate): NewFood {
  return {
    name: c.name, brand: c.brand, source: c.source, source_id: c.source_id,
    per100: { kcal_100: c.kcal_100, protein_100: c.protein_100, carb_100: c.carb_100, fat_100: c.fat_100, fiber_100: c.fiber_100, sugar_100: c.sugar_100 },
    serving_g: c.serving_g, serving_text: c.serving_text,
  }
}

// ---- writes --------------------------------------------------------------------------------------------

const enqueue = (table: string, row: object) => outbox.enqueue(table, row as unknown as Record<string, unknown>)

export async function addFood(input: NewFood): Promise<Food> {
  const ts = nowIso()
  const p = input.per100
  const row: Food = {
    id: uuid(), name: input.name.trim(), brand: input.brand?.trim() || null, source: input.source, source_id: input.source_id,
    kcal_100: r1(p.kcal_100), protein_100: r1(p.protein_100), carb_100: r1(p.carb_100), fat_100: r1(p.fat_100),
    fiber_100: p.fiber_100 == null ? null : r1(p.fiber_100), sugar_100: p.sugar_100 == null ? null : r1(p.sugar_100),
    serving_g: input.serving_g && input.serving_g > 0 ? r1(input.serving_g) : null, serving_text: input.serving_text?.trim() || null,
    label_json: input.label_json ?? null, use_count: 0, last_used_at: null, created_at: ts, updated_at: ts, deleted_at: null,
  }
  await enqueue('foods', row)
  return row
}

export async function updateFood(food: Food, patch: Partial<Food>): Promise<Food> {
  const row: Food = { ...food, ...patch, updated_at: nowIso() }
  await enqueue('foods', row)
  return row
}

/** The cached food a candidate maps to (same source + source_id), so scanning twice never creates a duplicate. */
export function existingFor(c: FoodCandidate, list: readonly Food[]): Food | null {
  return list.find((f) => f.source === c.source && f.source_id === c.source_id && !f.deleted_at) ?? null
}

async function bumpUse(table: 'foods' | 'meals', row: Food | Meal, at: string): Promise<void> {
  await enqueue(table, { ...row, use_count: row.use_count + 1, last_used_at: at, updated_at: at })
}

export async function logFood(food: Food, grams: number, slot: Slot, at: Date = new Date(), note: string | null = null): Promise<FoodLog> {
  const entry = buildFoodEntry(food, grams, { at, slot, tz: tz.value, note })
  await enqueue('food_log', entry)
  await bumpUse('foods', food, entry.updated_at)
  return entry
}

export async function logMeal(meal: Meal, scale: number, slot: Slot, at: Date = new Date(), note: string | null = null): Promise<FoodLog> {
  const entry = buildMealEntry(meal, scale, { at, slot, tz: tz.value, note })
  await enqueue('food_log', entry)
  await bumpUse('meals', meal, entry.updated_at)
  return entry
}

export async function deleteEntry(entry: FoodLog): Promise<void> {
  const ts = nowIso()
  await enqueue('food_log', { ...entry, updated_at: ts, deleted_at: ts })
}

export async function restoreEntry(entry: FoodLog): Promise<void> {
  await enqueue('food_log', { ...entry, updated_at: nowIso(), deleted_at: null })
}

/** Change the amount (grams for a food, scale for a meal) and/or the slot; the snapshot is recomputed. */
export async function editEntry(entry: FoodLog, patch: { amount?: number; slot?: Slot; note?: string | null }): Promise<FoodLog> {
  let next: FoodLog = entry
  if (patch.amount !== undefined) {
    const source = entry.food_id ? foods.value.find((f) => f.id === entry.food_id) ?? null : meals.value.find((m) => m.id === entry.meal_id) ?? null
    next = recomputeEntry(next, patch.amount, source)
  }
  if (patch.slot) next = { ...next, slot: patch.slot }
  if (patch.note !== undefined) next = { ...next, note: patch.note }
  next = { ...next, updated_at: nowIso(), deleted_at: null }
  await enqueue('food_log', next)
  return next
}

export interface SaveMealInput { id?: string; name: string; default_slot: Slot | null; items: MealItemInput[] }

/** Create or replace a meal: totals at 1x recomputed from the cached foods; removed items become tombstones. */
export async function saveMeal(input: SaveMealInput): Promise<Meal> {
  const ts = nowIso()
  const existing = input.id ? meals.value.find((m) => m.id === input.id) ?? null : null
  const calc = computeMeal(input.items, foods.value)
  const t = calc.totals
  const meal: Meal = {
    id: input.id ?? uuid(), name: input.name.trim(), total_g: r1(calc.total_g),
    kcal: t.kcal, protein_g: t.protein_g, carb_g: t.carb_g, fat_g: t.fat_g, fiber_g: t.fiber_g ?? null, sugar_g: t.sugar_g ?? null,
    default_slot: input.default_slot, use_count: existing?.use_count ?? 0, last_used_at: existing?.last_used_at ?? null,
    created_at: existing?.created_at ?? ts, updated_at: ts, deleted_at: null,
  }
  await enqueue('meals', meal)
  const old = mealItems.value.filter((i) => i.meal_id === meal.id)
  const keep = new Set<string>()
  for (const [i, it] of input.items.entries()) {
    // Reuse an existing row for the same food at the same position so edits stay idempotent across devices.
    const prev = old.find((o) => o.food_id === it.food_id && !keep.has(o.id))
    const row: MealItem = { id: prev?.id ?? uuid(), meal_id: meal.id, food_id: it.food_id, grams: r1(it.grams), position: i, updated_at: ts, deleted_at: null }
    keep.add(row.id)
    await enqueue('meal_items', row)
  }
  for (const o of old) if (!keep.has(o.id)) await enqueue('meal_items', { ...o, updated_at: ts, deleted_at: ts })
  return meal
}

/** Tombstone a meal and its items; logged rows keep their snapshots. */
export async function deleteMeal(meal: Meal): Promise<void> {
  const ts = nowIso()
  for (const it of mealItems.value.filter((i) => i.meal_id === meal.id)) await enqueue('meal_items', { ...it, updated_at: ts, deleted_at: ts })
  await enqueue('meals', { ...meal, updated_at: ts, deleted_at: ts })
}

export async function duplicateMeal(meal: Meal): Promise<Meal> {
  const items = mealItems.value.filter((i) => i.meal_id === meal.id).map((i) => ({ food_id: i.food_id, grams: i.grams }))
  return saveMeal({ name: `${meal.name} copy`, default_slot: meal.default_slot, items })
}

export async function saveAsMeal(entries: readonly FoodLog[], name: string, slot: Slot | null): Promise<Meal> {
  return saveMeal({ name, default_slot: slot, items: itemsFromEntries(entries, mealItems.value) })
}

// ---- lookups -------------------------------------------------------------------------------------------

export interface BarcodeLookup { candidate: FoodCandidate | null; source: 'off' | 'usda' | null; offline?: boolean }
export interface SearchResult { candidates: FoodCandidate[]; demo_key?: boolean; total?: number }

const BARCODE_KEY = (code: string) => `barcode:${code}`

async function fetchOFF(code: string): Promise<FoodCandidate | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 12_000)
  try {
    const res = await fetch(OFF_PRODUCT_URL(code), { signal: ctrl.signal }) // no custom headers: keeps the request CORS-simple
    if (!res.ok && res.status !== 404) return null
    return candidateFromOFF(await res.json(), code)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Open Food Facts first (direct), then USDA Branded through the Worker; a found code is cached in IndexedDB for good. */
export async function lookupBarcode(code: string): Promise<BarcodeLookup> {
  try {
    const hit = await get<BarcodeLookup>(BARCODE_KEY(code))
    if (hit?.candidate) return hit
  } catch { /* no IndexedDB */ }
  let result: BarcodeLookup = { candidate: null, source: null }
  const off = await fetchOFF(code)
  if (off && off.complete) result = { candidate: off, source: 'off' }
  else {
    try {
      const r = await apiGet<{ candidate: FoodCandidate | null }>(`/api/lookup/barcode/${encodeURIComponent(code)}`, `lookup:barcode:${code}`)
      if (r.data.candidate) result = { candidate: r.data.candidate, source: 'usda' }
      else if (off) result = { candidate: off, source: 'off' } // incomplete OFF beats nothing: the numbers are editable
    } catch (err) {
      if (off) result = { candidate: off, source: 'off' }
      else result = { candidate: null, source: null, offline: !(err instanceof ApiError) }
    }
  }
  if (result.candidate) void set(BARCODE_KEY(code), result).catch(() => {})
  return result
}

export async function searchUSDA(q: string, type: 'generic' | 'branded', page = 1): Promise<SearchResult> {
  const qs = `q=${encodeURIComponent(q.trim())}&type=${type}&page=${page}`
  const r = await apiGet<SearchResult>(`/api/lookup/search?${qs}`, `lookup:search:${type}:${page}:${q.trim().toLowerCase()}`)
  return r.data
}
