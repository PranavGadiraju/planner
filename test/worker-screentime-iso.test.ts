import { describe, expect, it } from 'vitest'
import { normIso } from '../src/worker/routes/screentime/payload'

describe('normIso', () => {
  it('accepts zoned timestamps and canonicalises them to UTC', () => {
    expect(normIso('2026-01-05T14:00:00Z')).toBe('2026-01-05T14:00:00.000Z')
    expect(normIso('2026-01-05T09:00:00-05:00')).toBe('2026-01-05T14:00:00.000Z')
    expect(normIso('2026-01-05T14:00+00:00')).toBe('2026-01-05T14:00:00.000Z')
  })
  it('rejects timestamps without a zone (they would parse as machine-local time)', () => {
    expect(normIso('2026-01-05T14:00')).toBeNull()
    expect(normIso('2026-01-05T14:00:00')).toBeNull()
    expect(normIso('2026-01-05')).toBeNull()
    expect(normIso(42)).toBeNull()
  })
})
