// lookupBarcode's cache rule and the flush hook's "use bump" filter, with IndexedDB replaced by a Map and the Worker
// call mocked. hasToken is false here so the outbox keeps every queued row instead of flushing it mid-test.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Food } from '@shared/types'

const store = vi.hoisted(() => new Map<string, unknown>())
const apiGet = vi.hoisted(() => vi.fn())

vi.mock('idb-keyval', () => ({
  get: vi.fn(async (k: string) => store.get(k)),
  set: vi.fn(async (k: string, v: unknown) => { store.set(k, v) }),
  del: vi.fn(async (k: string) => { store.delete(k) }),
  keys: vi.fn(async () => [...store.keys()]),
  clear: vi.fn(async () => { store.clear() }),
  createStore: vi.fn(),
}))
vi.mock('../src/app/data/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/app/data/api')>()
  return { ...real, apiGet: (...args: unknown[]) => apiGet(...args), hasToken: () => false }
})

import { logFood, lookupBarcode, staleAfterFlush } from '../src/app/data/food'
import * as outbox from '../src/app/data/outbox'

const CODE = '0016000275270'
const offBody = (nutriments: Record<string, number>) => ({
  status: 1,
  product: { code: CODE, product_name: 'Cheerios', brands: 'General Mills', serving_quantity: 39, serving_size: '1 cup (39 g)', nutriments },
})
const COMPLETE = { 'energy-kcal_100g': 359, proteins_100g: 10.3, carbohydrates_100g: 74.4, fat_100g: 5.1 }
const NO_FAT = { 'energy-kcal_100g': 359, proteins_100g: 10.3, carbohydrates_100g: 74.4 }

const fetchMock = vi.fn()

beforeEach(() => {
  store.clear()
  fetchMock.mockReset()
  apiGet.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

describe('lookupBarcode caching', () => {
  it('caches a complete Open Food Facts hit and answers the next scan from it', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(offBody(COMPLETE)), { status: 200 }))
    const r1 = await lookupBarcode(CODE)
    expect(r1.source).toBe('off')
    expect(r1.candidate).toMatchObject({ name: 'Cheerios', complete: true, fat_100: 5.1 })
    expect(store.has(`barcode:${CODE}`)).toBe(true)
    expect(apiGet).not.toHaveBeenCalled()
    const r2 = await lookupBarcode(CODE)
    expect(r2).toEqual(r1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('does not cache an incomplete candidate, so the USDA fallback is retried next time', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(offBody(NO_FAT)), { status: 200 }))
    apiGet.mockResolvedValue({ data: { candidate: null }, cached: false, fetchedAt: '2026-09-28T00:00:00.000Z' })
    const r1 = await lookupBarcode(CODE)
    expect(r1.source).toBe('off')
    expect(r1.candidate).toMatchObject({ complete: false, fat_100: 0 })
    expect(apiGet).toHaveBeenCalledTimes(1)
    expect(store.has(`barcode:${CODE}`)).toBe(false)
    // USDA reachable now and complete: it wins, and this one is cached.
    const usda = { name: 'Cheerios', brand: 'General Mills', source: 'usda', source_id: '123', kcal_100: 359, protein_100: 10.3, carb_100: 74.4, fat_100: 5.1, fiber_100: null, sugar_100: null, serving_g: 39, serving_text: null, complete: true }
    apiGet.mockResolvedValue({ data: { candidate: usda }, cached: false, fetchedAt: '2026-09-28T00:00:00.000Z' })
    const r2 = await lookupBarcode(CODE)
    expect(r2.source).toBe('usda')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(apiGet).toHaveBeenCalledTimes(2)
    expect(store.has(`barcode:${CODE}`)).toBe(true)
  })
  it('keeps an incomplete hit out of the cache when the Worker is unreachable', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(offBody(NO_FAT)), { status: 200 }))
    apiGet.mockRejectedValue(new TypeError('Failed to fetch'))
    const r = await lookupBarcode(CODE)
    expect(r.source).toBe('off')
    expect(r.candidate?.complete).toBe(false)
    expect(store.has(`barcode:${CODE}`)).toBe(false)
  })
})

describe('flush hook: use bumps do not refetch the lists', () => {
  const food: Food = {
    id: 'f1', name: 'Greek yogurt', brand: 'Fage', source: 'label', source_id: null,
    kcal_100: 97, protein_100: 9, carb_100: 3.8, fat_100: 5, fiber_100: null, sugar_100: 3.8,
    serving_g: 170, serving_text: null, label_json: null, use_count: 3, last_used_at: null,
    created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z', deleted_at: null,
  }
  it('treats the bump row a log enqueues as not stale, and a real edit as stale', async () => {
    await outbox.clearQueue()
    const entry = await logFood(food, 100, 'lunch', new Date('2026-09-28T16:00:00.000Z'))
    const queued = (await outbox.peek()).map((it) => ({ table: it.table, row: it.row }))
    expect(queued.map((it) => it.table)).toEqual(['food_log', 'foods'])
    expect(queued[1]?.row).toMatchObject({ id: 'f1', use_count: 4, last_used_at: entry.updated_at, updated_at: entry.updated_at })
    expect(staleAfterFlush(queued)).toEqual({ lists: false, days: [entry.local_day] })
    // The tag is consumed by that flush; the same row seen again (or any edit) refreshes the lists.
    expect(staleAfterFlush(queued).lists).toBe(true)
    expect(staleAfterFlush([{ table: 'foods', row: { ...food, name: 'Yogurt', updated_at: '2026-09-28T17:00:00.000Z' } }])).toEqual({ lists: true, days: [] })
    expect(staleAfterFlush([{ table: 'meal_items', row: { id: 'i1', updated_at: 'x' } }]).lists).toBe(true)
    expect(staleAfterFlush([{ table: 'food_log', row: { id: 'e', local_day: '2026-09-27' } }, { table: 'food_log', row: { id: 'e2', local_day: '2026-09-27' } }])).toEqual({ lists: false, days: ['2026-09-27'] })
  })
})
