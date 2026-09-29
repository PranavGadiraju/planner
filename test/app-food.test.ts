import { describe, expect, it } from 'vitest'
import type { Food, FoodLog, Meal, MealItem } from '@shared/types'
import {
  buildFoodEntry, buildMealEntry, computeMeal, dayTotals, entryDetail, existingFor, foodByBarcode, foodFromCandidate, groupBySlot, itemsFromEntries,
  labelPer100, mergeRows, recomputeEntry, searchLocal, slotAt, topMeals, EMPTY_LABEL_FORM,
} from '../src/app/data/food'
import { expandUpcE, resolveGtin, scannedGtin } from '../src/app/screens/food/gtin'
import { parseHash } from '../src/app/router'

const TZ = 'America/New_York'
const T0 = '2026-09-01T00:00:00.000Z'

const food = (over: Partial<Food> = {}): Food => ({
  id: 'f1', name: 'Greek yogurt', brand: 'Fage', source: 'label', source_id: null,
  kcal_100: 97, protein_100: 9, carb_100: 3.8, fat_100: 5, fiber_100: null, sugar_100: 3.8,
  serving_g: 170, serving_text: '3/4 cup (170 g)', label_json: null, use_count: 3, last_used_at: '2026-09-27T12:00:00.000Z',
  created_at: T0, updated_at: T0, deleted_at: null, ...over,
})
const meal = (over: Partial<Meal> = {}): Meal => ({
  id: 'm1', name: 'Oats bowl', total_g: 320, kcal: 520, protein_g: 24, carb_g: 70, fat_g: 14, fiber_g: 9, sugar_g: null,
  default_slot: 'breakfast', use_count: 8, last_used_at: '2026-09-27T11:00:00.000Z', created_at: T0, updated_at: T0, deleted_at: null, ...over,
})

describe('local search ranking', () => {
  const foods = [
    food({ id: 'a', name: 'Oats', use_count: 2 }),
    food({ id: 'b', name: 'Overnight oats', use_count: 9 }),
    food({ id: 'c', name: 'Rolled oats', brand: 'Quaker', use_count: 5 }),
    food({ id: 'd', name: 'Granola', brand: 'Oatly', use_count: 1 }),
    food({ id: 'e', name: 'Chicken', use_count: 40 }),
  ]
  const meals = [meal({ id: 'm', name: 'Oats bowl', use_count: 1 })]
  it('puts name prefix matches before word-prefix, substring and brand matches, then most used', () => {
    const ids = searchLocal('oat', foods, meals).map((h) => (h.kind === 'food' ? h.food.id : `meal:${h.meal.id}`))
    expect(ids).toEqual(['meal:m', 'a', 'b', 'c', 'd'])
  })
  it('is case-insensitive and ignores non-matches', () => {
    expect(searchLocal('CHICK', foods, meals).map((h) => (h.kind === 'food' ? h.food.id : ''))).toEqual(['e'])
    expect(searchLocal('zzz', foods, meals)).toEqual([])
  })
  it('lists the most used items (meals first) for an empty query', () => {
    const ids = searchLocal('', foods, meals, 3).map((h) => (h.kind === 'food' ? h.food.id : `meal:${h.meal.id}`))
    expect(ids).toEqual(['meal:m', 'e', 'b'])
  })
})

describe('quick-add ranking', () => {
  it('weights use_count by recency and caps at n', () => {
    const now = new Date('2026-09-28T12:00:00.000Z')
    const list = [
      meal({ id: 'old', name: 'Old favourite', use_count: 20, last_used_at: '2026-06-01T00:00:00.000Z' }),
      meal({ id: 'hot', name: 'This week', use_count: 6, last_used_at: '2026-09-27T00:00:00.000Z' }),
      meal({ id: 'new', name: 'Never logged', use_count: 0, last_used_at: null }),
      meal({ id: 'mid', name: 'Last month', use_count: 10, last_used_at: '2026-08-28T00:00:00.000Z' }),
    ]
    expect(topMeals(list, now, 3).map((m) => m.id)).toEqual(['hot', 'mid', 'old'])
    expect(topMeals(list, now).map((m) => m.id)).toEqual(['hot', 'mid', 'old', 'new'])
  })
})

describe('snapshots', () => {
  const at = new Date('2026-09-28T11:40:00.000Z') // 07:40 local
  it('builds a food entry with per-100 math on the local day', () => {
    const e = buildFoodEntry(food(), 180, { at, slot: slotAt(at, TZ), tz: TZ })
    expect(e).toMatchObject({ local_day: '2026-09-28', slot: 'breakfast', food_id: 'f1', meal_id: null, grams: 180, scale: null, label: 'Greek yogurt', kcal: 174.6, protein_g: 16.2, carb_g: 6.8, fat_g: 9, fiber_g: null, sugar_g: 6.8, source: 'app', deleted_at: null })
    expect(e.ts).toBe(at.toISOString())
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(entryDetail(e)).toBe('180 g · 175 kcal · 16P')
  })
  it('builds a meal entry at a scale', () => {
    const e = buildMealEntry(meal(), 1.5, { at, slot: 'lunch', tz: TZ })
    expect(e).toMatchObject({ slot: 'lunch', meal_id: 'm1', food_id: null, scale: 1.5, grams: null, kcal: 780, protein_g: 36, carb_g: 105, fat_g: 21, fiber_g: 13.5, sugar_g: null })
    expect(entryDetail(e)).toBe('1.5x · 780 kcal · 36P')
  })
  it('recomputes from the source when cached, proportionally when not', () => {
    const e = buildFoodEntry(food(), 100, { at, slot: 'snack', tz: TZ })
    expect(recomputeEntry(e, 50, food())).toMatchObject({ grams: 50, kcal: 48.5, protein_g: 4.5 })
    expect(recomputeEntry(e, 200, null)).toMatchObject({ grams: 200, kcal: 194, protein_g: 18, sugar_g: 7.6 })
    const m = buildMealEntry(meal(), 1, { at, slot: 'dinner', tz: TZ })
    expect(recomputeEntry(m, 0.5, null)).toMatchObject({ scale: 0.5, kcal: 260, fiber_g: 4.5 })
    expect(recomputeEntry(m, 2, meal())).toMatchObject({ scale: 2, kcal: 1040 })
  })
  it('infers the slot from local time', () => {
    expect(slotAt(new Date('2026-09-28T17:30:00.000Z'), TZ)).toBe('lunch') // 13:30
    expect(slotAt(new Date('2026-09-29T01:00:00.000Z'), TZ)).toBe('snack') // 21:00
  })
})

describe('day totals and grouping', () => {
  const at = new Date('2026-09-28T12:00:00.000Z')
  const entries: FoodLog[] = [
    buildFoodEntry(food(), 100, { at, slot: 'breakfast', tz: TZ }),
    { ...buildMealEntry(meal(), 1, { at, slot: 'dinner', tz: TZ }), id: 'x2' },
    { ...buildFoodEntry(food(), 100, { at, slot: 'breakfast', tz: TZ }), id: 'x3', deleted_at: T0 },
    { ...buildFoodEntry(food(), 50, { at, slot: 'lunch', tz: TZ }), id: 'x4' },
  ]
  it('sums live entries only and groups in slot order with subtotals', () => {
    expect(dayTotals(entries)).toMatchObject({ kcal: 665.5, protein_g: 37.5 })
    const g = groupBySlot(entries)
    expect(g.map((x) => [x.slot, x.entries.length, x.totals.kcal])).toEqual([['breakfast', 1, 97], ['lunch', 1, 48.5], ['dinner', 1, 520]])
  })
})

describe('meals', () => {
  const foods = [food({ id: 'y', name: 'Yogurt', kcal_100: 97, protein_100: 9, carb_100: 3.8, fat_100: 5 }), food({ id: 'o', name: 'Oats', kcal_100: 389, protein_100: 16.9, carb_100: 66.3, fat_100: 6.9, fiber_100: 10.6 })]
  it('recomputes totals at 1x from cached foods and reports unknown ids', () => {
    const c = computeMeal([{ food_id: 'y', grams: 200 }, { food_id: 'o', grams: 50 }, { food_id: 'nope', grams: 10 }], foods)
    expect(c.total_g).toBe(250)
    expect(c.totals).toMatchObject({ kcal: 388.5, protein_g: 26.5, carb_g: 40.8, fat_g: 13.5, fiber_g: 5.3 })
    expect(c.missing).toEqual(['nope'])
    expect(c.per100.kcal_100).toBe(155.4)
  })
  it('flattens logged entries into items, expanding meals by scale', () => {
    const items: MealItem[] = [
      { id: 'i1', meal_id: 'm1', food_id: 'y', grams: 200, position: 0, updated_at: T0, deleted_at: null },
      { id: 'i2', meal_id: 'm1', food_id: 'o', grams: 50, position: 1, updated_at: T0, deleted_at: null },
      { id: 'i3', meal_id: 'm1', food_id: 'gone', grams: 50, position: 2, updated_at: T0, deleted_at: T0 },
    ]
    const at = new Date('2026-09-28T12:00:00.000Z')
    const entries = [buildFoodEntry(food({ id: 'y' }), 120, { at, slot: 'lunch', tz: TZ }), buildMealEntry(meal(), 0.5, { at, slot: 'lunch', tz: TZ })]
    expect(itemsFromEntries(entries, items)).toEqual([{ food_id: 'y', grams: 120 }, { food_id: 'y', grams: 100 }, { food_id: 'o', grams: 25 }])
  })
})

describe('merging and candidates', () => {
  it('keeps the newest row per id and drops tombstones', () => {
    const a = food({ id: '1', name: 'old', updated_at: '2026-09-01T00:00:00.000Z' })
    const b = food({ id: '1', name: 'new', updated_at: '2026-09-02T00:00:00.000Z' })
    const c = food({ id: '2', name: 'gone', updated_at: '2026-09-02T00:00:00.000Z', deleted_at: '2026-09-02T00:00:00.000Z' })
    expect(mergeRows([a, food({ id: '2' })], [b, c]).map((f) => f.name)).toEqual(['new'])
    expect(mergeRows([b], [a]).map((f) => f.name)).toEqual(['new'])
  })
  it('maps a candidate to a new food and finds an already-saved one by source id', () => {
    const cand = { name: 'Cheerios', brand: 'General Mills', source: 'off' as const, source_id: '0016000275270', kcal_100: 359, protein_100: 10.3, carb_100: 74.4, fat_100: 5.1, fiber_100: 10.3, sugar_100: 5.1, serving_g: 39, serving_text: '1 cup (39 g)', complete: true }
    expect(foodFromCandidate(cand)).toEqual({ name: 'Cheerios', brand: 'General Mills', source: 'off', source_id: '0016000275270', per100: { kcal_100: 359, protein_100: 10.3, carb_100: 74.4, fat_100: 5.1, fiber_100: 10.3, sugar_100: 5.1 }, serving_g: 39, serving_text: '1 cup (39 g)' })
    const saved = food({ id: 's', source: 'off', source_id: '0016000275270' })
    expect(existingFor(cand, [food(), saved])).toBe(saved)
    expect(existingFor({ ...cand, source: 'usda' }, [saved])).toBeNull()
  })
  it('finds the saved food for a barcode whatever source saved it, across UPC-A / EAN-13 spellings', () => {
    const byLabel = food({ id: 'l', source: 'label', source_id: '042100005264' })
    const byOff = food({ id: 'o', source: 'off', source_id: '0016000275270' })
    const byUsda = food({ id: 'u', source: 'usda', source_id: '2345678', label_json: JSON.stringify({ barcode: '0041570054161', fetched: {} }) })
    const byCli = food({ id: 'c', source: 'claude', source_id: '96385074' })
    const gone = food({ id: 'g', source: 'label', source_id: '4006381333931', deleted_at: T0 })
    const junk = food({ id: 'j', source: 'label', source_id: null, label_json: '{not json "barcode"' })
    const list = [food(), byLabel, byOff, byUsda, byCli, gone, junk]
    expect(foodByBarcode('042100005264', list)).toBe(byLabel)
    expect(foodByBarcode('0042100005264', list)).toBe(byLabel) // EAN-13 spelling of the UPC-A
    expect(foodByBarcode('16000275270', list)).toBe(byOff)
    expect(foodByBarcode('041570054161', list)).toBe(byUsda) // a scanned USDA hit keeps the code in label_json only
    expect(foodByBarcode('96385074', list)).toBe(byCli)
    expect(foodByBarcode('4006381333931', list)).toBeNull() // tombstoned
    expect(foodByBarcode('2345678', list)).toBeNull() // a USDA fdcId is not a barcode
    expect(foodByBarcode('', list)).toBeNull()
  })
})

describe('GTIN helpers for the scanner', () => {
  it('expands UPC-E (8 digits with the UPC-A check digit, or the bare 6) by its last data digit', () => {
    expect(expandUpcE('04252614')).toBe('042100005264') // last digit 0-2: XX + d + 0000 + YYY
    expect(expandUpcE('16543205')).toBe('165000004325') // number system 1
    expect(expandUpcE('01234531')).toBe('012300000451') // 3: XXX + 00000 + YY
    expect(expandUpcE('01234543')).toBe('012340000053') // 4: XXXX + 00000 + Y
    expect(expandUpcE('01234558')).toBe('012345000058') // 5-9: XXXXX + 0000 + d
    expect(expandUpcE('425261')).toBe('042100005264') // six data digits: check digit computed
    expect(expandUpcE('96385075')).toBe('96385075') // number system 9 is not UPC-E
    expect(expandUpcE('0016000275270')).toBe('0016000275270')
  })
  it('expands only upc_e detector hits', () => {
    expect(scannedGtin('upc_e', '04252614')).toBe('042100005264')
    expect(scannedGtin('ean_8', '96385074')).toBe('96385074')
    expect(scannedGtin('ean_13', '0016000275270')).toBe('0016000275270')
  })
  it('resolves typed or scanned digits to the code to look up', () => {
    expect(resolveGtin('0016000275270')).toBe('0016000275270')
    expect(resolveGtin('042100005264')).toBe('042100005264')
    expect(resolveGtin('96385074')).toBe('96385074') // a valid EAN-8 stays EAN-8
    expect(resolveGtin('04252614')).toBe('042100005264') // fails as EAN-8, holds as UPC-E
    expect(resolveGtin('96385075')).toBeNull() // fails both ways
    expect(resolveGtin('0016000275271')).toBeNull()
    expect(resolveGtin('12')).toBeNull()
  })
})

describe('label form', () => {
  it('converts per-serving to per 100 g and needs the serving grams', () => {
    const f = { ...EMPTY_LABEL_FORM, name: 'Cereal', serving_g: '55', kcal: '210', protein: '6', carb: '40', fat: '3', fiber: '4', sugar: '12' }
    const r = labelPer100(f)!
    expect(r.per100).toEqual({ kcal_100: 381.8, protein_100: 10.9, carb_100: 72.7, fat_100: 5.5, fiber_100: 7.3, sugar_100: 21.8 })
    expect(r.basis.kcal).toBe(210)
    expect(r.serving_g).toBe(55)
    expect(labelPer100({ ...f, serving_g: '' })).toBeNull()
  })
  it('takes per-100 values directly with optional fiber/sugar', () => {
    const r = labelPer100({ ...EMPTY_LABEL_FORM, mode: 'per100', kcal: '130', protein: '2.7', carb: '28', fat: '0.3' })!
    expect(r.per100).toEqual({ kcal_100: 130, protein_100: 2.7, carb_100: 28, fat_100: 0.3, fiber_100: null, sugar_100: null })
    expect(r.serving_g).toBeNull()
  })
})

describe('food routes in the hash router', () => {
  it('hands sub-segments to the tab', () => {
    expect(parseHash('#/food')).toEqual({ name: 'food', rest: [] })
    expect(parseHash('#/food/log')).toEqual({ name: 'food', rest: ['log'] })
    expect(parseHash('#/food/meal/abc')).toEqual({ name: 'food', rest: ['meal', 'abc'] })
  })
})
