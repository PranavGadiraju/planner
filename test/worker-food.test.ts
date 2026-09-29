import { describe, expect, it } from 'vitest'
import {
  buildLogRow, candidatesFromSearch, gtinSpellings, likePattern, matchBarcode, mealSnapshot, parseAt, parseFoodBody, parseLimit, parseLogBody, pickByName,
  slotFor, totalsFromRow, usdaSearchBody,
} from '../src/worker/routes/food/helpers'
import { HttpError } from '../src/worker/http'
import type { Food, Meal } from '@shared/types'

const TZ = 'America/New_York'
const NOW = new Date('2026-09-28T16:20:00.000Z') // 12:20 local (EDT)

const status = (fn: () => unknown): { status: number; message: string } => {
  try {
    fn()
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, message: e.message }
    throw e
  }
  throw new Error('expected an HttpError')
}

const food = (over: Partial<Food> = {}): Food => ({
  id: 'f1', name: 'Greek yogurt', brand: 'Fage', source: 'label', source_id: null,
  kcal_100: 97, protein_100: 9, carb_100: 3.8, fat_100: 5, fiber_100: null, sugar_100: 3.8,
  serving_g: 170, serving_text: '3/4 cup (170 g)', label_json: null, use_count: 3, last_used_at: null,
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null, ...over,
})
const meal = (over: Partial<Meal> = {}): Meal => ({
  id: 'm1', name: 'Oats bowl', total_g: 320, kcal: 520, protein_g: 24, carb_g: 70, fat_g: 14, fiber_g: 9, sugar_g: null,
  default_slot: 'breakfast', use_count: 8, last_used_at: null,
  created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null, ...over,
})

describe('POST /api/foods body', () => {
  it('converts per-serving numbers to per 100 g and stores the audit label_json', () => {
    const { row, warnings } = parseFoodBody({
      name: ' Cheerios ', brand: 'General Mills', serving_g: 39, serving_text: '1 cup (39 g)',
      per_serving: { kcal: 140, protein_g: 5, carb_g: 29, fat_g: 2.5, fiber_g: 4, sugar_g: 2 }, label_json: { kcal: 140 },
    }, NOW)
    expect(row).toMatchObject({
      name: 'Cheerios', brand: 'General Mills', source: 'claude', serving_g: 39, serving_text: '1 cup (39 g)',
      kcal_100: 359, protein_100: 12.8, carb_100: 74.4, fat_100: 6.4, fiber_100: 10.3, sugar_100: 5.1,
      use_count: 0, last_used_at: null, deleted_at: null, label_json: '{"kcal":140}',
    })
    expect(row.created_at).toBe(NOW.toISOString())
    expect(row.updated_at).toBe(NOW.toISOString())
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(warnings).toEqual([]) // 4*5 + 4*29 + 9*2.5 = 158.5 vs 140: within max(15 %, 25 kcal)
  })
  it('flags (never blocks) an inconsistent label', () => {
    const { row, warnings } = parseFoodBody({ name: 'Weird bar', serving_g: 50, per_serving: { kcal: 100, protein_g: 20, carb_g: 30, fat_g: 10 } }, NOW)
    expect(row.kcal_100).toBe(200)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/imply 290 kcal but 100 kcal/)
  })
  it('takes per100 directly (and keeps the id and source it was given)', () => {
    const { row } = parseFoodBody({ id: 'abc', name: 'Rice', source: 'usda', source_id: 169756, per100: { kcal_100: 130, protein_100: 2.7, carb_100: 28, fat_100: 0.3 } }, NOW)
    expect(row).toMatchObject({ id: 'abc', source: 'usda', source_id: '169756', kcal_100: 130, fiber_100: null, sugar_100: null, serving_g: null })
  })
  it('rejects bad bodies with 400s', () => {
    expect(status(() => parseFoodBody(null, NOW))).toMatchObject({ status: 400, message: 'body must be a JSON object' })
    expect(status(() => parseFoodBody({ per100: { kcal_100: 1 } }, NOW))).toMatchObject({ status: 400, message: 'name required' })
    expect(status(() => parseFoodBody({ name: 'x' }, NOW))).toMatchObject({ status: 400, message: 'per_serving (with serving_g) or per100 required' })
    expect(status(() => parseFoodBody({ name: 'x', per_serving: { kcal: 1, protein_g: 0, carb_g: 0, fat_g: 0 } }, NOW))).toMatchObject({ status: 400, message: 'serving_g is required with per_serving' })
    expect(status(() => parseFoodBody({ name: 'x', serving_g: 0, per_serving: { kcal: 1, protein_g: 0, carb_g: 0, fat_g: 0 } }, NOW))).toMatchObject({ status: 400, message: 'serving_g must be > 0' })
    expect(status(() => parseFoodBody({ name: 'x', per100: { kcal_100: 'lots', protein_100: 0, carb_100: 0, fat_100: 0 } }, NOW))).toMatchObject({ status: 400, message: 'per100.kcal_100 must be a number >= 0' })
    expect(status(() => parseFoodBody({ name: 'x', source: 'magic', per100: { kcal_100: 1, protein_100: 0, carb_100: 0, fat_100: 0 } }, NOW)).status).toBe(400)
  })
})

describe('POST /api/food-log body', () => {
  it('parses a food by name with grams, HH:MM local time and an explicit slot', () => {
    const b = parseLogBody({ food_name: 'yogurt', grams: 180, at: '07:45', slot: 'breakfast', note: 'with honey' }, NOW, TZ)
    expect(b.target).toEqual({ kind: 'food', id: null, name: 'yogurt' })
    expect(b.grams).toBe(180)
    expect(b.scale).toBeNull()
    expect(b.at.toISOString()).toBe('2026-09-28T11:45:00.000Z')
    expect(b.slot).toBe('breakfast')
    expect(b.note).toBe('with honey')
  })
  it('defaults a meal to scale 1 at now', () => {
    const b = parseLogBody({ meal_id: 'm1' }, NOW, TZ)
    expect(b.target).toEqual({ kind: 'meal', id: 'm1', name: null })
    expect(b.scale).toBe(1)
    expect(b.at).toBe(NOW)
    expect(b.slot).toBeNull()
  })
  it('rejects missing / double targets, bad grams and unknown slots', () => {
    expect(status(() => parseLogBody({ grams: 10 }, NOW, TZ)).message).toMatch(/exactly one of/)
    expect(status(() => parseLogBody({ food_id: 'a', meal_id: 'b', grams: 10 }, NOW, TZ)).message).toMatch(/exactly one of/)
    expect(status(() => parseLogBody({ food_id: 'a' }, NOW, TZ)).message).toBe('grams (> 0) required for a food')
    expect(status(() => parseLogBody({ meal_id: 'a', scale: 0 }, NOW, TZ)).message).toBe('scale must be > 0')
    expect(status(() => parseLogBody({ food_id: 'a', grams: 10, slot: 'brunch' }, NOW, TZ)).message).toMatch(/slot must be one of/)
    expect(status(() => parseLogBody({ food_id: 'a', grams: 10, at: 'yesterday' }, NOW, TZ)).message).toMatch(/at must be/)
  })
  it('parseAt accepts ISO instants and HH:MM on the local day', () => {
    expect(parseAt('2026-09-27T23:00:00Z', NOW, TZ).toISOString()).toBe('2026-09-27T23:00:00.000Z')
    expect(parseAt('9:05', NOW, TZ).toISOString()).toBe('2026-09-28T13:05:00.000Z')
    expect(parseAt(undefined, NOW, TZ)).toBe(NOW)
    expect(status(() => parseAt('25:00', NOW, TZ)).message).toBe('at: HH:MM out of range')
  })
})

describe('name resolution', () => {
  const rows = [{ name: 'Oats' }, { name: 'Oats bowl' }, { name: 'Overnight oats' }]
  it('prefers an exact case-insensitive match', () => {
    expect(pickByName(rows, 'oats', 'food')).toBe(rows[0])
  })
  it('accepts a single LIKE hit', () => {
    expect(pickByName([rows[1]!], 'bowl', 'meal')).toBe(rows[1])
  })
  it('400s on none or ambiguous', () => {
    expect(status(() => pickByName([], 'kale', 'food'))).toMatchObject({ status: 400, message: 'no food matches "kale"' })
    const e = status(() => pickByName(rows, 'oat', 'food'))
    expect(e.status).toBe(400)
    expect(e.message).toBe('"oat" is ambiguous: Oats, Oats bowl, Overnight oats')
  })
})

describe('snapshot rows', () => {
  it('scales a food per 100 g into a food_log row on the local day of `at`', () => {
    const at = new Date('2026-09-29T02:30:00.000Z') // 22:30 local on the 28th
    const row = buildLogRow({ food: food(), grams: 180, scale: null, at, slot: slotFor(at, TZ, null), note: null, tz: TZ, now: NOW })
    expect(row).toMatchObject({
      local_day: '2026-09-28', slot: 'snack', food_id: 'f1', meal_id: null, grams: 180, scale: null, label: 'Greek yogurt',
      kcal: 174.6, protein_g: 16.2, carb_g: 6.8, fat_g: 9, fiber_g: null, sugar_g: 6.8, source: 'cli', deleted_at: null,
    })
    expect(row.ts).toBe(at.toISOString())
    expect(row.created_at).toBe(NOW.toISOString())
  })
  it('multiplies meal totals by the scale and infers the slot from the local hour', () => {
    const row = buildLogRow({ meal: meal(), grams: null, scale: 1.5, at: NOW, slot: slotFor(NOW, TZ, null), note: 'big', tz: TZ, now: NOW })
    expect(row).toMatchObject({ slot: 'lunch', meal_id: 'm1', food_id: null, scale: 1.5, grams: null, kcal: 780, protein_g: 36, carb_g: 105, fat_g: 21, fiber_g: 13.5, sugar_g: null, note: 'big' })
    expect(mealSnapshot(meal(), 0.5)).toEqual({ kcal: 260, protein_g: 12, carb_g: 35, fat_g: 7, fiber_g: 4.5, sugar_g: null })
  })
  it('keeps an explicit slot', () => {
    expect(slotFor(NOW, TZ, 'dinner')).toBe('dinner')
    expect(slotFor(new Date('2026-09-28T11:00:00.000Z'), TZ, null)).toBe('breakfast')
  })
})

describe('USDA helpers', () => {
  it('builds the search body per type', () => {
    expect(usdaSearchBody('oats', 'generic', 1)).toEqual({ query: 'oats', dataType: ['Foundation', 'SR Legacy'], pageSize: 15, pageNumber: 1 })
    expect(usdaSearchBody('cheerios', 'branded', 3)).toEqual({ query: 'cheerios', dataType: ['Branded'], pageSize: 15, pageNumber: 3 })
    expect(usdaSearchBody('x', 'generic', 0).pageNumber).toBe(1)
  })
  const hit = (gtin: string, fdcId: number) => ({
    fdcId, description: `Product ${fdcId}`, gtinUpc: gtin, servingSize: 30, servingSizeUnit: 'g',
    foodNutrients: [{ nutrientId: 1008, value: 400 }, { nutrientId: 1003, value: 10 }, { nutrientId: 1005, value: 60 }, { nutrientId: 1004, value: 12 }],
  })
  it('matches a barcode across UPC-A / EAN-13 spellings', () => {
    const foods = [hit('00012345678905', 1), hit('016000275270', 2), { fdcId: 3, description: 'no gtin' }]
    expect(matchBarcode(foods, '0016000275270')?.source_id).toBe('2')
    expect(matchBarcode(foods, '012345678905')?.source_id).toBe('1')
    expect(matchBarcode(foods, '9999999999999')).toBeNull()
    expect(matchBarcode(foods, '')).toBeNull()
  })
  it('spells a GTIN every way USDA stores it, in one OR-ed query', () => {
    expect(gtinSpellings('0016000275270')).toEqual(['0016000275270', '16000275270', '016000275270', '00016000275270'])
    expect(gtinSpellings('012345678905')).toEqual(['012345678905', '12345678905', '0012345678905', '00012345678905'])
    expect(gtinSpellings('12345678')).toEqual(['12345678', '000012345678', '0000012345678', '00000012345678'])
    expect(gtinSpellings('')).toEqual([])
  })
  it('drops hits without energy when mapping search results', () => {
    const c = candidatesFromSearch([hit('1', 7), { fdcId: 8, description: 'empty', foodNutrients: [] }])
    expect(c.map((x) => x.source_id)).toEqual(['7'])
    expect(c[0]).toMatchObject({ kcal_100: 400, serving_g: 30, complete: true })
  })
})

describe('small helpers', () => {
  it('escapes LIKE wildcards', () => {
    expect(likePattern('50% off_sale')).toBe('%50\\% off\\_sale%')
    expect(likePattern('a\\b')).toBe('%a\\\\b%')
  })
  it('clamps limits', () => {
    expect(parseLimit(null, 50, 1000)).toBe(50)
    expect(parseLimit('abc', 50, 1000)).toBe(50)
    expect(parseLimit('0', 50, 1000)).toBe(50)
    expect(parseLimit('7.9', 50, 1000)).toBe(7)
    expect(parseLimit('99999', 50, 1000)).toBe(1000)
  })
  it('rounds SQL sums and keeps unknown fiber/sugar as null', () => {
    expect(totalsFromRow({ kcal: 1234.56, protein_g: 80.04, carb_g: 150, fat_g: 40.25, fiber_g: null, sugar_g: 12 }))
      .toEqual({ kcal: 1234.6, protein_g: 80, carb_g: 150, fat_g: 40.3, fiber_g: null, sugar_g: 12 })
    expect(totalsFromRow(undefined)).toEqual({ kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: null, sugar_g: null })
    expect(totalsFromRow({ kcal: null, protein_g: null, carb_g: null, fat_g: null, fiber_g: null, sugar_g: null }).kcal).toBe(0)
  })
})
