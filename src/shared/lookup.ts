// Normalizers for the two free nutrition databases into one per-100 g "food candidate" shape.
// Verified 2026-09-28: OFF v3 product-by-barcode is CORS-open and reliable (gate on energy-kcal_100g, never on status);
// USDA FoodData Central search is CORS-open with a free key; nutrient ids 1008 kcal, 1003 protein, 1005 carbs, 1004 fat,
// 1079 fiber, 2000 then 1063 sugars; repeated ids must be de-duplicated by first occurrence.
import type { Slot } from './types'

export interface FoodCandidate {
  name: string
  brand: string | null
  source: 'off' | 'usda'
  source_id: string
  kcal_100: number
  protein_100: number
  carb_100: number
  fat_100: number
  fiber_100: number | null
  sugar_100: number | null
  serving_g: number | null
  serving_text: string | null
  /** false when one of protein/carb/fat was missing and defaulted to 0. */
  complete: boolean
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
const r1 = (n: number) => Math.round(n * 10) / 10

export const OFF_PRODUCT_URL = (code: string) =>
  `https://world.openfoodfacts.org/api/v3/product/${encodeURIComponent(code)}?fields=code,product_name,product_name_en,brands,serving_size,serving_quantity,nutrition_data_per,nutriments,states_tags`

/** Open Food Facts v3 product -> candidate. Returns null when the product has no usable energy value (placeholder products exist). */
export function candidateFromOFF(body: unknown, code: string): FoodCandidate | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  const product = (b.product && typeof b.product === 'object' ? b.product : null) as Record<string, unknown> | null
  if (!product) return null
  const n = (product.nutriments && typeof product.nutriments === 'object' ? product.nutriments : {}) as Record<string, unknown>
  let kcal = num(n['energy-kcal_100g'])
  if (kcal === null) {
    const kj = num(n['energy-kj_100g']) ?? (String(n['energy_unit'] ?? 'kJ').toLowerCase() === 'kcal' ? null : num(n['energy_100g']))
    if (kj !== null) kcal = kj / 4.184
    else {
      const e = num(n['energy_100g'])
      if (e !== null && String(n['energy_unit'] ?? '').toLowerCase() === 'kcal') kcal = e
    }
  }
  if (kcal === null) return null
  const protein = num(n['proteins_100g']), carb = num(n['carbohydrates_100g']), fat = num(n['fat_100g'])
  const name = String(product.product_name_en || product.product_name || '').trim()
  const servingQ = num(product.serving_quantity)
  return {
    name: name || `Product ${code}`,
    brand: typeof product.brands === 'string' && product.brands.trim() ? product.brands.split(',')[0]!.trim() : null,
    source: 'off',
    source_id: String(product.code ?? code),
    kcal_100: r1(kcal),
    protein_100: r1(protein ?? 0),
    carb_100: r1(carb ?? 0),
    fat_100: r1(fat ?? 0),
    fiber_100: num(n['fiber_100g']) === null ? null : r1(num(n['fiber_100g'])!),
    sugar_100: num(n['sugars_100g']) === null ? null : r1(num(n['sugars_100g'])!),
    serving_g: servingQ !== null && servingQ > 0 ? r1(servingQ) : null,
    serving_text: typeof product.serving_size === 'string' && product.serving_size.trim() ? product.serving_size.trim() : null,
    complete: protein !== null && carb !== null && fat !== null,
  }
}

export const USDA_IDS = { kcal: 1008, kj: 1062, protein: 1003, carb: 1005, fat: 1004, fiber: 1079, sugar: 2000, sugarAlt: 1063 } as const

/** USDA FoodData Central search hit (or /food/{id} record) -> candidate; values are per 100 g. */
export function candidateFromUSDA(hit: unknown): FoodCandidate | null {
  if (!hit || typeof hit !== 'object') return null
  const h = hit as Record<string, unknown>
  const list = Array.isArray(h.foodNutrients) ? (h.foodNutrients as Record<string, unknown>[]) : []
  const first = new Map<number, number>()
  for (const fn of list) {
    const id = num(fn.nutrientId ?? (fn.nutrient as Record<string, unknown> | undefined)?.id)
    const value = num(fn.value ?? fn.amount)
    if (id === null || value === null || first.has(id)) continue
    first.set(id, value)
  }
  let kcal = first.get(USDA_IDS.kcal) ?? null
  if (kcal === null && first.has(USDA_IDS.kj)) kcal = first.get(USDA_IDS.kj)! / 4.184
  if (kcal === null) return null
  const protein = first.get(USDA_IDS.protein) ?? null, carb = first.get(USDA_IDS.carb) ?? null, fat = first.get(USDA_IDS.fat) ?? null
  const sugar = first.get(USDA_IDS.sugar) ?? first.get(USDA_IDS.sugarAlt) ?? null
  const fiber = first.get(USDA_IDS.fiber) ?? null
  const servingSize = num(h.servingSize)
  const unit = String(h.servingSizeUnit ?? '').toLowerCase()
  const household = typeof h.householdServingFullText === 'string' ? h.householdServingFullText.trim() : ''
  const brand = [h.brandName, h.brandOwner].find((v) => typeof v === 'string' && v.trim()) as string | undefined
  return {
    name: String(h.description ?? '').trim() || `USDA ${h.fdcId}`,
    brand: brand ? brand.trim() : null,
    source: 'usda',
    source_id: String(h.fdcId ?? ''),
    kcal_100: r1(kcal),
    protein_100: r1(protein ?? 0),
    carb_100: r1(carb ?? 0),
    fat_100: r1(fat ?? 0),
    fiber_100: fiber === null ? null : r1(fiber),
    sugar_100: sugar === null ? null : r1(sugar),
    serving_g: servingSize !== null && servingSize > 0 && (unit === 'g' || unit === 'grm' || unit === 'ml' || unit === 'mlt') ? r1(servingSize) : null,
    serving_text: household ? (servingSize !== null ? `${household} (${servingSize} ${unit || 'g'})` : household) : null,
    complete: protein !== null && carb !== null && fat !== null,
  }
}

/** Strip leading zeros so UPC-A (12), EAN-13 and GTIN-14 spellings of the same code compare equal. */
export function normalizeGtin(code: string): string {
  return code.replace(/\D/g, '').replace(/^0+(?=\d)/, '')
}

/** Meal slot from local wall-clock time: breakfast before 10:30, lunch before 15:00, dinner before 20:30, else snack. */
export function inferSlot(hour: number, minute = 0): Slot {
  const t = hour * 60 + minute
  if (t < 4 * 60) return 'snack'
  if (t < 10 * 60 + 30) return 'breakfast'
  if (t < 15 * 60) return 'lunch'
  if (t < 20 * 60 + 30) return 'dinner'
  return 'snack'
}
