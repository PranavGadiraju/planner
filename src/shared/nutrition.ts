export interface Macros { kcal: number; protein_g: number; carb_g: number; fat_g: number; fiber_g?: number | null; sugar_g?: number | null }
export interface Per100 { kcal_100: number; protein_100: number; carb_100: number; fat_100: number; fiber_100?: number | null; sugar_100?: number | null }

const r1 = (n: number) => Math.round(n * 10) / 10

/** Convert label per-serving values to per-100 g. */
export function per100FromServing(perServing: Macros, servingG: number): Per100 {
  if (!(servingG > 0)) throw new Error('serving grams must be > 0')
  const f = 100 / servingG
  return {
    kcal_100: r1(perServing.kcal * f), protein_100: r1(perServing.protein_g * f),
    carb_100: r1(perServing.carb_g * f), fat_100: r1(perServing.fat_g * f),
    fiber_100: perServing.fiber_g == null ? null : r1(perServing.fiber_g * f),
    sugar_100: perServing.sugar_g == null ? null : r1(perServing.sugar_g * f),
  }
}

/** Macros for `grams` of a per-100 g food. */
export function scalePer100(p: Per100, grams: number): Macros {
  const f = grams / 100
  return {
    kcal: r1(p.kcal_100 * f), protein_g: r1(p.protein_100 * f), carb_g: r1(p.carb_100 * f), fat_g: r1(p.fat_100 * f),
    fiber_g: p.fiber_100 == null ? null : r1(p.fiber_100 * f), sugar_g: p.sugar_100 == null ? null : r1(p.sugar_100 * f),
  }
}

export function sumMacros(list: Macros[]): Macros {
  const out: Macros = { kcal: 0, protein_g: 0, carb_g: 0, fat_g: 0, fiber_g: 0, sugar_g: 0 }
  let fiberKnown = false, sugarKnown = false
  for (const m of list) {
    out.kcal += m.kcal; out.protein_g += m.protein_g; out.carb_g += m.carb_g; out.fat_g += m.fat_g
    if (m.fiber_g != null) { out.fiber_g = (out.fiber_g ?? 0) + m.fiber_g; fiberKnown = true }
    if (m.sugar_g != null) { out.sugar_g = (out.sugar_g ?? 0) + m.sugar_g; sugarKnown = true }
  }
  return {
    kcal: r1(out.kcal), protein_g: r1(out.protein_g), carb_g: r1(out.carb_g), fat_g: r1(out.fat_g),
    fiber_g: fiberKnown ? r1(out.fiber_g ?? 0) : null, sugar_g: sugarKnown ? r1(out.sugar_g ?? 0) : null,
  }
}

/** Totals of a recipe at scale 1.0 plus its per-100 g profile. */
export function mealTotals(items: { per100: Per100; grams: number }[]): { total_g: number; totals: Macros; per100: Per100 } {
  const total_g = items.reduce((a, i) => a + i.grams, 0)
  const totals = sumMacros(items.map((i) => scalePer100(i.per100, i.grams)))
  const per100: Per100 = total_g > 0
    ? {
        kcal_100: r1((totals.kcal * 100) / total_g), protein_100: r1((totals.protein_g * 100) / total_g),
        carb_100: r1((totals.carb_g * 100) / total_g), fat_100: r1((totals.fat_g * 100) / total_g),
        fiber_100: totals.fiber_g == null ? null : r1((totals.fiber_g * 100) / total_g),
        sugar_100: totals.sugar_g == null ? null : r1((totals.sugar_g * 100) / total_g),
      }
    : { kcal_100: 0, protein_100: 0, carb_100: 0, fat_100: 0, fiber_100: null, sugar_100: null }
  return { total_g, totals, per100 }
}

/** Atwater 4/4/9 sanity check. Flags (never blocks) when the label's kcal is far from what the macros imply. */
export function atwaterCheck(m: { kcal: number; protein_g: number; carb_g: number; fat_g: number }): { ok: boolean; implied: number; diff: number; pct: number } {
  const implied = 4 * m.protein_g + 4 * m.carb_g + 9 * m.fat_g
  const diff = Math.abs(implied - m.kcal)
  const tolerance = Math.max(0.15 * m.kcal, 25)
  return { ok: diff <= tolerance, implied: r1(implied), diff: r1(diff), pct: m.kcal > 0 ? r1((diff / m.kcal) * 100) : 0 }
}

/** EAN/UPC check digit (GTIN-8/12/13/14). */
export function validGtin(code: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(code)) return false
  const digits = code.split('').map(Number)
  const check = digits.pop() as number
  let sum = 0
  digits.reverse().forEach((d, i) => { sum += d * (i % 2 === 0 ? 3 : 1) })
  return (10 - (sum % 10)) % 10 === check
}

export function epley1RM(weight: number, reps: number): number {
  if (reps <= 1) return weight
  return r1(weight * (1 + reps / 30))
}
