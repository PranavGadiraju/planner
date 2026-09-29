import { describe, expect, it } from 'vitest'
import { candidateFromOFF, candidateFromUSDA, inferSlot, normalizeGtin } from '@shared/lookup'

describe('Open Food Facts normalizer', () => {
  const product = {
    status: 'success',
    product: {
      code: '0016000275270', product_name: 'Cheerios', brands: 'General Mills, Cheerios', serving_size: '1 cup (39 g)', serving_quantity: '39',
      nutriments: { 'energy-kcal_100g': 359, proteins_100g: 10.3, carbohydrates_100g: 74.4, fat_100g: 5.1, fiber_100g: 10.3, sugars_100g: 5.1, 'energy_100g': 1502 },
    },
  }
  it('maps per-100 g fields, serving grams and the first brand', () => {
    const c = candidateFromOFF(product, '0016000275270')!
    expect(c).toMatchObject({ name: 'Cheerios', brand: 'General Mills', source: 'off', kcal_100: 359, protein_100: 10.3, carb_100: 74.4, fat_100: 5.1, fiber_100: 10.3, sugar_100: 5.1, serving_g: 39, serving_text: '1 cup (39 g)', complete: true })
  })
  it('rejects placeholder products with no energy even when status says found', () => {
    expect(candidateFromOFF({ status: 'success', product: { code: '1234567890128' } }, '1234567890128')).toBeNull()
  })
  it('falls back to kJ / 4.184 for EU products missing energy-kcal', () => {
    const c = candidateFromOFF({ product: { code: 'x', product_name: 'Muesli', nutriments: { energy_100g: 1502, energy_unit: 'kJ', proteins_100g: 10, carbohydrates_100g: 60, fat_100g: 8 } } }, 'x')!
    expect(c.kcal_100).toBe(359)
  })
  it('marks incomplete macros', () => {
    const c = candidateFromOFF({ product: { code: 'x', product_name: 'Thing', nutriments: { 'energy-kcal_100g': 100, proteins_100g: 5 } } }, 'x')!
    expect(c.complete).toBe(false)
    expect(c.carb_100).toBe(0)
  })
})

describe('USDA normalizer', () => {
  it('takes the first occurrence of repeated nutrient ids and prefers 2000 over 1063 for sugars', () => {
    const hit = {
      fdcId: 2503923, description: 'CHEERIOS', brandOwner: 'General Mills', servingSize: 39, servingSizeUnit: 'g', householdServingFullText: '1 cup',
      foodNutrients: [
        { nutrientId: 1008, value: 359 }, { nutrientId: 1008, value: 117 }, { nutrientId: 1003, value: 10.3 }, { nutrientId: 1005, value: 74.4 },
        { nutrientId: 1004, value: 5.13 }, { nutrientId: 1079, value: 10.3 }, { nutrientId: 1063, value: 9 }, { nutrientId: 2000, value: 5.13 },
      ],
    }
    const c = candidateFromUSDA(hit)!
    expect(c).toMatchObject({ name: 'CHEERIOS', brand: 'General Mills', source: 'usda', source_id: '2503923', kcal_100: 359, protein_100: 10.3, carb_100: 74.4, fat_100: 5.1, fiber_100: 10.3, sugar_100: 5.1, serving_g: 39, serving_text: '1 cup (39 g)', complete: true })
  })
  it('handles foundation foods with only 1063 sugars and no serving', () => {
    const c = candidateFromUSDA({ fdcId: 1750340, description: 'Apples, fuji, with skin, raw', foodNutrients: [{ nutrientId: 1008, value: 65 }, { nutrientId: 1003, value: 0.15 }, { nutrientId: 1005, value: 15.7 }, { nutrientId: 1004, value: 0.16 }, { nutrientId: 1063, value: 13.3 }] })!
    expect(c.sugar_100).toBe(13.3)
    expect(c.serving_g).toBeNull()
    expect(c.brand).toBeNull()
  })
  it('returns null without an energy value', () => {
    expect(candidateFromUSDA({ fdcId: 1, description: 'x', foodNutrients: [{ nutrientId: 1003, value: 1 }] })).toBeNull()
  })
})

describe('helpers', () => {
  it('normalizes GTIN spellings', () => {
    expect(normalizeGtin('0016000275270')).toBe('16000275270')
    expect(normalizeGtin('016000275270')).toBe('16000275270')
    expect(normalizeGtin('0')).toBe('0')
  })
  it('infers meal slots', () => {
    expect(inferSlot(7, 30)).toBe('breakfast')
    expect(inferSlot(10, 30)).toBe('lunch')
    expect(inferSlot(14, 59)).toBe('lunch')
    expect(inferSlot(19, 0)).toBe('dinner')
    expect(inferSlot(22, 0)).toBe('snack')
    expect(inferSlot(2, 0)).toBe('snack')
  })
})
