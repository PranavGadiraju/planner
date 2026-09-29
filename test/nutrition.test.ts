import { describe, expect, it } from 'vitest'
import { atwaterCheck, epley1RM, mealTotals, per100FromServing, scalePer100, validGtin } from '@shared/nutrition'

describe('nutrition math', () => {
  it('per-serving label to per-100 g', () => {
    const p = per100FromServing({ kcal: 120, protein_g: 3, carb_g: 24, fat_g: 1.5 }, 30)
    expect(p).toMatchObject({ kcal_100: 400, protein_100: 10, carb_100: 80, fat_100: 5 })
  })
  it('scales per-100 g by grams', () => {
    expect(scalePer100({ kcal_100: 400, protein_100: 10, carb_100: 80, fat_100: 5 }, 45)).toMatchObject({ kcal: 180, protein_g: 4.5, carb_g: 36, fat_g: 2.3 })
  })
  it('meal totals and per-100 profile', () => {
    const m = mealTotals([
      { per100: { kcal_100: 130, protein_100: 2.7, carb_100: 28, fat_100: 0.3 }, grams: 200 }, // rice
      { per100: { kcal_100: 165, protein_100: 31, carb_100: 0, fat_100: 3.6 }, grams: 150 },   // chicken
    ])
    expect(m.total_g).toBe(350)
    expect(m.totals.kcal).toBe(507.5)
    expect(m.per100.kcal_100).toBe(145)
  })
  it('atwater flags a label whose kcal does not match its macros', () => {
    expect(atwaterCheck({ kcal: 120, protein_g: 3, carb_g: 24, fat_g: 1.5 }).ok).toBe(true)
    expect(atwaterCheck({ kcal: 300, protein_g: 3, carb_g: 24, fat_g: 1.5 }).ok).toBe(false)
    expect(atwaterCheck({ kcal: 10, protein_g: 0, carb_g: 5, fat_g: 0 }).ok).toBe(true) // small servings use a 25 kcal floor
  })
  it('GTIN check digits', () => {
    expect(validGtin('0012345678905')).toBe(true) // UPC-A with a leading zero
    expect(validGtin('012345678905')).toBe(true)
    expect(validGtin('4006381333931')).toBe(true) // EAN-13
    expect(validGtin('4006381333932')).toBe(false)
    expect(validGtin('12345')).toBe(false)
  })
  it('epley', () => {
    expect(epley1RM(100, 1)).toBe(100)
    expect(epley1RM(100, 10)).toBe(133.3)
  })
})
