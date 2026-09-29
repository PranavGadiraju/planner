// Pure helpers behind the food routes: body parsing for the Claude Code helpers (POST /api/foods, POST /api/food-log),
// snapshot math, name resolution rules, LIKE escaping and the USDA request/response shapes. No D1 or Worker globals
// beyond crypto.randomUUID, so vitest covers them.
import type { Food, FoodLog, Meal, Slot } from '../../../shared/types'
import { atwaterCheck, per100FromServing, scalePer100, type Macros, type Per100 } from '../../../shared/nutrition'
import { candidateFromUSDA, inferSlot, normalizeGtin, type FoodCandidate } from '../../../shared/lookup'
import { localDay, localParts, zonedToUTC } from '../../../shared/tz'
import { HttpError, isRecord } from '../../http'

export const SLOTS: readonly Slot[] = ['breakfast', 'lunch', 'dinner', 'snack']
export const FOOD_SOURCES = ['label', 'off', 'usda', 'claude'] as const
export type FoodSource = (typeof FOOD_SOURCES)[number]

const r1 = (n: number) => Math.round(n * 10) / 10

export function isSlot(v: unknown): v is Slot {
  return typeof v === 'string' && (SLOTS as readonly string[]).includes(v)
}

/** `%text%` for a LIKE ... ESCAPE '\' clause, with the user's own wildcards neutralised. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Clamp a ?limit= value to [1, max]; the default applies when it is missing or unparsable. */
export function parseLimit(raw: string | null, dflt: number, max: number): number {
  const n = Number(raw)
  if (!raw || !Number.isFinite(n) || n < 1) return dflt
  return Math.min(max, Math.floor(n))
}

// ---- POST /api/foods -------------------------------------------------------------------------------

function finite(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
/** A required non-negative number field. */
function reqNum(o: Record<string, unknown>, key: string, where: string): number {
  const n = finite(o[key])
  if (n === null || n < 0) throw new HttpError(400, `${where}.${key} must be a number >= 0`)
  return n
}
/** An optional non-negative number field (absent/null -> null). */
function optNum(o: Record<string, unknown>, key: string, where: string): number | null {
  if (o[key] === undefined || o[key] === null) return null
  const n = finite(o[key])
  if (n === null || n < 0) throw new HttpError(400, `${where}.${key} must be a number >= 0`)
  return n
}
function optStr(o: Record<string, unknown>, key: string): string | null {
  const v = o[key]
  if (v === undefined || v === null) return null
  if (typeof v === 'number') return String(v)
  if (typeof v !== 'string') throw new HttpError(400, `${key} must be a string`)
  const t = v.trim()
  return t ? t : null
}

function readMacros(o: Record<string, unknown>, where: string): Macros {
  return {
    kcal: reqNum(o, 'kcal', where), protein_g: reqNum(o, 'protein_g', where), carb_g: reqNum(o, 'carb_g', where), fat_g: reqNum(o, 'fat_g', where),
    fiber_g: optNum(o, 'fiber_g', where), sugar_g: optNum(o, 'sugar_g', where),
  }
}
function readPer100(o: Record<string, unknown>): Per100 {
  return {
    kcal_100: reqNum(o, 'kcal_100', 'per100'), protein_100: reqNum(o, 'protein_100', 'per100'),
    carb_100: reqNum(o, 'carb_100', 'per100'), fat_100: reqNum(o, 'fat_100', 'per100'),
    fiber_100: optNum(o, 'fiber_100', 'per100'), sugar_100: optNum(o, 'sugar_100', 'per100'),
  }
}

export function atwaterWarning(m: { kcal: number; protein_g: number; carb_g: number; fat_g: number }, basis: string): string | null {
  const a = atwaterCheck(m)
  if (a.ok) return null
  return `4/4/9 check (${basis}): the macros imply ${a.implied} kcal but ${m.kcal} kcal was given (${a.diff} kcal, ${a.pct}% off)`
}

/**
 * The foods row POST /api/foods upserts. With a caller-supplied id (the documented way to correct a food) use_count and
 * last_used_at are left out: validateRow skips undefined columns, so the guarded upsert neither resets the ranking of an
 * existing food nor needs them for a new one (schema defaults 0 / NULL). created_at is carried over by createFood.
 */
export type FoodUpsert = Omit<Food, 'use_count' | 'last_used_at'> & Partial<Pick<Food, 'use_count' | 'last_used_at'>>
export interface ParsedFood { row: FoodUpsert; warnings: string[]; givenId: boolean }

/**
 * {id?, name, brand?, serving_g?, serving_text?, per_serving?, per100?, source?, source_id?, label_json?} -> a foods row.
 * per100 wins when both are given; per_serving needs serving_g; the 4/4/9 check only ever warns.
 */
export function parseFoodBody(body: unknown, now: Date): ParsedFood {
  if (!isRecord(body)) throw new HttpError(400, 'body must be a JSON object')
  const name = typeof body['name'] === 'string' ? body['name'].trim() : ''
  if (!name) throw new HttpError(400, 'name required')
  let id: string = crypto.randomUUID()
  const givenId = body['id'] !== undefined && body['id'] !== null
  if (givenId) {
    if (typeof body['id'] !== 'string' || !body['id'].trim()) throw new HttpError(400, 'id must be a non-empty string')
    id = body['id'].trim()
  }
  let source: FoodSource = 'claude'
  if (body['source'] !== undefined && body['source'] !== null) {
    if (!(FOOD_SOURCES as readonly unknown[]).includes(body['source'])) throw new HttpError(400, `source must be one of ${FOOD_SOURCES.join(', ')}`)
    source = body['source'] as FoodSource
  }
  const serving_g = optNum(body, 'serving_g', 'body')
  if (serving_g !== null && serving_g <= 0) throw new HttpError(400, 'serving_g must be > 0')
  let label_json: string | null = null
  if (body['label_json'] !== undefined && body['label_json'] !== null) {
    label_json = typeof body['label_json'] === 'string' ? body['label_json'] : JSON.stringify(body['label_json'])
  }

  const warnings: string[] = []
  let per100: Per100
  if (isRecord(body['per100'])) {
    per100 = readPer100(body['per100'])
    const w = atwaterWarning({ kcal: per100.kcal_100, protein_g: per100.protein_100, carb_g: per100.carb_100, fat_g: per100.fat_100 }, 'per 100 g')
    if (w) warnings.push(w)
  } else if (isRecord(body['per_serving'])) {
    if (serving_g === null) throw new HttpError(400, 'serving_g is required with per_serving')
    const ps = readMacros(body['per_serving'], 'per_serving')
    per100 = per100FromServing(ps, serving_g)
    const w = atwaterWarning(ps, `per serving of ${serving_g} g`)
    if (w) warnings.push(w)
  } else {
    throw new HttpError(400, 'per_serving (with serving_g) or per100 required')
  }

  const ts = now.toISOString()
  const row: FoodUpsert = {
    id, name, brand: optStr(body, 'brand'), source, source_id: optStr(body, 'source_id'),
    kcal_100: per100.kcal_100, protein_100: per100.protein_100, carb_100: per100.carb_100, fat_100: per100.fat_100,
    fiber_100: per100.fiber_100 ?? null, sugar_100: per100.sugar_100 ?? null,
    serving_g, serving_text: optStr(body, 'serving_text'), label_json,
    created_at: ts, updated_at: ts, deleted_at: null,
    ...(givenId ? {} : { use_count: 0, last_used_at: null }),
  }
  return { row, warnings, givenId }
}

// ---- POST /api/food-log ----------------------------------------------------------------------------

export interface LogBody {
  target: { kind: 'food'; id: string | null; name: string | null } | { kind: 'meal'; id: string | null; name: string | null }
  grams: number | null
  scale: number | null
  at: Date
  slot: Slot | null
  note: string | null
}

/** 'HH:MM' (today in tz) or an ISO instant; absent -> now. */
export function parseAt(raw: unknown, now: Date, tz: string): Date {
  if (raw === undefined || raw === null || raw === '') return now
  if (typeof raw !== 'string') throw new HttpError(400, 'at must be an ISO timestamp or HH:MM')
  const s = raw.trim()
  if (/^\d{1,2}:\d{2}$/.test(s)) {
    const [h, m] = s.split(':').map(Number) as [number, number]
    if (h > 23 || m > 59) throw new HttpError(400, 'at: HH:MM out of range')
    return zonedToUTC(localDay(now, tz), `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, tz)
  }
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) throw new HttpError(400, 'at must be an ISO timestamp or HH:MM')
  return d
}

export function parseLogBody(body: unknown, now: Date, tz: string): LogBody {
  if (!isRecord(body)) throw new HttpError(400, 'body must be a JSON object')
  const food_id = optStr(body, 'food_id'), food_name = optStr(body, 'food_name')
  const meal_id = optStr(body, 'meal_id'), meal_name = optStr(body, 'meal_name')
  const isFood = !!(food_id || food_name), isMeal = !!(meal_id || meal_name)
  if (isFood === isMeal) throw new HttpError(400, 'exactly one of food_id, food_name, meal_id, meal_name is required')
  const grams = optNum(body, 'grams', 'body')
  const scale = optNum(body, 'scale', 'body')
  if (isFood && (grams === null || grams <= 0)) throw new HttpError(400, 'grams (> 0) required for a food')
  if (isMeal && scale !== null && scale <= 0) throw new HttpError(400, 'scale must be > 0')
  let slot: Slot | null = null
  if (body['slot'] !== undefined && body['slot'] !== null) {
    if (!isSlot(body['slot'])) throw new HttpError(400, `slot must be one of ${SLOTS.join(', ')}`)
    slot = body['slot']
  }
  return {
    target: isFood ? { kind: 'food', id: food_id, name: food_name } : { kind: 'meal', id: meal_id, name: meal_name },
    grams: isFood ? grams : null,
    scale: isMeal ? scale ?? 1 : null,
    at: parseAt(body['at'], now, tz),
    slot,
    note: optStr(body, 'note'),
  }
}

/** The one row a name refers to: an exact (case-insensitive) match wins, otherwise the list must have exactly one hit. */
export function pickByName<T extends { name: string }>(rows: readonly T[], q: string, what: string): T {
  const lq = q.trim().toLowerCase()
  const exact = rows.filter((r) => r.name.trim().toLowerCase() === lq)
  if (exact.length === 1) return exact[0] as T
  if (rows.length === 1) return rows[0] as T
  if (rows.length === 0) throw new HttpError(400, `no ${what} matches "${q}"`)
  const names = rows.slice(0, 5).map((r) => r.name).join(', ')
  throw new HttpError(400, `"${q}" is ambiguous: ${names}`, { candidates: rows.slice(0, 5).map((r) => r.name) })
}

export function slotFor(at: Date, tz: string, given: Slot | null): Slot {
  if (given) return given
  const p = localParts(at, tz)
  return inferSlot(p.h, p.mi)
}

export function mealSnapshot(meal: Pick<Meal, 'kcal' | 'protein_g' | 'carb_g' | 'fat_g' | 'fiber_g' | 'sugar_g'>, scale: number): Macros {
  return {
    kcal: r1(meal.kcal * scale), protein_g: r1(meal.protein_g * scale), carb_g: r1(meal.carb_g * scale), fat_g: r1(meal.fat_g * scale),
    fiber_g: meal.fiber_g == null ? null : r1(meal.fiber_g * scale), sugar_g: meal.sugar_g == null ? null : r1(meal.sugar_g * scale),
  }
}

export interface LogInput {
  food?: Food
  meal?: Meal
  grams: number | null
  scale: number | null
  at: Date
  slot: Slot
  note: string | null
  tz: string
  now: Date
}

/** Build the food_log row with its macro snapshot (a later edit of the food or meal never rewrites it). */
export function buildLogRow(input: LogInput): FoodLog {
  const { food, meal, at, slot, tz, now } = input
  let macros: Macros
  let label: string
  if (food) {
    const grams = input.grams ?? 0
    macros = scalePer100(food, grams)
    label = food.name
  } else if (meal) {
    macros = mealSnapshot(meal, input.scale ?? 1)
    label = meal.name
  } else {
    throw new Error('buildLogRow: food or meal required')
  }
  const ts = now.toISOString()
  return {
    id: crypto.randomUUID(), ts: at.toISOString(), local_day: localDay(at, tz), slot,
    food_id: food ? food.id : null, meal_id: meal ? meal.id : null,
    grams: food ? input.grams : null, scale: meal ? input.scale : null,
    label, kcal: macros.kcal, protein_g: macros.protein_g, carb_g: macros.carb_g, fat_g: macros.fat_g,
    fiber_g: macros.fiber_g ?? null, sugar_g: macros.sugar_g ?? null,
    note: input.note, source: 'cli', created_at: ts, updated_at: ts, deleted_at: null,
  }
}

// ---- USDA ------------------------------------------------------------------------------------------

export type LookupType = 'generic' | 'branded'

export function usdaSearchBody(q: string, type: LookupType, page: number, pageSize = 15): Record<string, unknown> {
  return { query: q, dataType: type === 'branded' ? ['Branded'] : ['Foundation', 'SR Legacy'], pageSize, pageNumber: Math.max(1, page) }
}

/** Map a USDA search answer's foods[] to candidates (hits without an energy value are dropped). */
export function candidatesFromSearch(foods: unknown[]): FoodCandidate[] {
  const out: FoodCandidate[] = []
  for (const f of foods) {
    const c = candidateFromUSDA(f)
    if (c) out.push(c)
  }
  return out
}

/**
 * Every spelling USDA might store for a GTIN (the search is an exact token match on gtinUpc, which is 12, 13 or 14
 * digits depending on the product): the code as scanned, its zero-padded 12/13/14-digit forms and the bare digits.
 * Space-separated terms are OR-ed by the search, so one request covers them all (verified 2026-09-29).
 */
export function gtinSpellings(code: string): string[] {
  const bare = normalizeGtin(code)
  if (!bare) return []
  const out = new Set<string>([code.replace(/\D/g, ''), bare])
  for (const len of [12, 13, 14]) if (bare.length <= len) out.add(bare.padStart(len, '0'))
  return [...out].filter(Boolean)
}

/** The first Branded hit whose gtinUpc equals `code` once both are normalised (UPC-A vs EAN-13 spellings). */
export function matchBarcode(foods: unknown[], code: string): FoodCandidate | null {
  const want = normalizeGtin(code)
  if (!want) return null
  for (const f of foods) {
    if (!isRecord(f)) continue
    const g = f['gtinUpc']
    if (typeof g !== 'string' && typeof g !== 'number') continue
    if (normalizeGtin(String(g)) !== want) continue
    const c = candidateFromUSDA(f)
    if (c) return c
  }
  return null
}

/** Totals shape shared by GET /api/food-log's totals and by_slot (SQL sums, rounded to 0.1 here). */
export interface LogTotals { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g: number | null; sugar_g: number | null }
export const EMPTY_TOTALS: LogTotals = { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: null, sugar_g: null }

export function totalsFromRow(r: Record<string, unknown> | null | undefined): LogTotals {
  if (!r) return EMPTY_TOTALS
  const n = (k: string) => r1(Number(r[k] ?? 0))
  const opt = (k: string) => (r[k] === null || r[k] === undefined ? null : r1(Number(r[k])))
  return { kcal: n('kcal'), protein_g: n('protein_g'), carb_g: n('carb_g'), fat_g: n('fat_g'), fiber_g: opt('fiber_g'), sugar_g: opt('sugar_g') }
}
