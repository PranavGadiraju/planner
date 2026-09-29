import { describe, expect, it } from 'vitest'
import { isOversize, shrinkBatch } from '../src/app/data/outbox'

describe('outbox oversize handling', () => {
  it('treats 413 and the Worker\'s "at most N rows" 400 as too big, other 4xx as wrong', () => {
    expect(isOversize(413, 'Payload Too Large')).toBe(true)
    expect(isOversize(400, 'at most 200 rows per request')).toBe(true)
    expect(isOversize(400, '  At most 200 rows per request')).toBe(true)
    expect(isOversize(400, 'atmost')).toBe(false)
    expect(isOversize(400, 'bad row: sets.reps must be a number')).toBe(false)
    expect(isOversize(422, 'at most 200 rows per request')).toBe(false)
    expect(isOversize(500, 'at most 200 rows per request')).toBe(false)
  })
  it('halves the batch (rounding up) until a single row is left, which is buried', () => {
    expect(shrinkBatch(200)).toBe(100)
    expect(shrinkBatch(3)).toBe(2)
    expect(shrinkBatch(2)).toBe(1)
    expect(shrinkBatch(1)).toBeNull()
    expect(shrinkBatch(0)).toBeNull()
    // 200 rows converge in at most 8 splits
    let n: number | null = 200
    let steps = 0
    while (n !== null) { n = shrinkBatch(n); steps++ }
    expect(steps).toBe(9)
  })
})
