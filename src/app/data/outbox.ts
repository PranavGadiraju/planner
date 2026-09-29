// Ordered write queue in IndexedDB. Every row is an idempotent upsert, so replaying is always safe.
import { signal } from '@preact/signals'
import { get, set } from 'idb-keyval'
import type { WriteRequest, WriteResponse } from '@shared/types'
import { ApiError, apiPost, authFailed, hasToken } from './api'
import { uuid } from './format'

export interface OutboxItem {
  id: string
  table: string
  row: Record<string, unknown>
  queued_at: string
  attempts: number
}

const KEY = 'outbox'
const MAX_BATCH = 200
const BACKOFF_MS = [2_000, 10_000, 60_000] as const

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'unauthorized'

/** Rows waiting to be written. */
export const pending = signal(0)
export const status = signal<SyncStatus>('idle')
export const lastError = signal<string | null>(null)

type EnqueueHook = (table: string, row: Record<string, unknown>) => void
type RejectHook = (table: string, key: string, reason: string) => void
const enqueueHooks: EnqueueHook[] = []
const rejectHooks: RejectHook[] = []

/** Called synchronously on every enqueue so the store can apply the row optimistically. */
export function onEnqueue(fn: EnqueueHook): () => void {
  enqueueHooks.push(fn)
  return () => { const i = enqueueHooks.indexOf(fn); if (i >= 0) enqueueHooks.splice(i, 1) }
}
/** Called when the server rejects a row (it is dropped from the queue). */
export function onReject(fn: RejectHook): () => void {
  rejectHooks.push(fn)
  return () => { const i = rejectHooks.indexOf(fn); if (i >= 0) rejectHooks.splice(i, 1) }
}

// Serialise queue access so concurrent enqueue()/flush() calls never clobber each other.
let chain: Promise<unknown> = Promise.resolve()
function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn)
  chain = p.catch(() => {})
  return p
}

async function readQueue(): Promise<OutboxItem[]> {
  try {
    const q = await get<OutboxItem[]>(KEY)
    return Array.isArray(q) ? q : []
  } catch {
    return []
  }
}
async function writeQueue(q: OutboxItem[]): Promise<void> {
  try { await set(KEY, q) } catch { /* storage unavailable: keep going in memory */ }
  pending.value = q.length
}

export async function peek(): Promise<OutboxItem[]> {
  return readQueue()
}

export async function enqueue(table: string, row: Record<string, unknown>): Promise<void> {
  for (const h of enqueueHooks) h(table, row)
  await locked(async () => {
    const q = await readQueue()
    q.push({ id: uuid(), table, row, queued_at: new Date().toISOString(), attempts: 0 })
    await writeQueue(q)
  })
  void flush()
}

export async function clearQueue(): Promise<void> {
  await locked(() => writeQueue([]))
}

let inFlight: Promise<void> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let failures = 0

function scheduleRetry(): void {
  if (retryTimer) return
  const delay = BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)] ?? 60_000
  retryTimer = setTimeout(() => { retryTimer = null; void flush() }, delay)
}

/** Sends queued rows in batches of up to 200. Only one flush runs at a time; callers can await it. */
export function flush(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = run().finally(() => { inFlight = null })
  return inFlight
}

async function run(): Promise<void> {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
  const q = await readQueue()
  pending.value = q.length
  if (q.length === 0) { status.value = 'idle'; return }
  if (!hasToken()) { status.value = 'unauthorized'; return }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) { status.value = 'error'; lastError.value = 'offline'; scheduleRetry(); return }

  status.value = 'syncing'
  const batch = q.slice(0, MAX_BATCH)
  const body: WriteRequest = { mutations: [] }
  for (const item of batch) {
    let m = body.mutations.find((x) => x.table === item.table)
    if (!m) { m = { table: item.table, rows: [] }; body.mutations.push(m) }
    m.rows.push(item.row)
  }

  let res: WriteResponse
  try {
    res = await apiPost<WriteResponse>('/api/write', body)
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      status.value = 'unauthorized'
      lastError.value = 'Token rejected'
      authFailed.value = true
      return // stop until the token changes; flush() is called again by setToken users
    }
    failures++
    lastError.value = err instanceof Error ? err.message : String(err)
    status.value = 'error'
    await locked(async () => {
      const cur = await readQueue()
      const ids = new Set(batch.map((b) => b.id))
      for (const it of cur) if (ids.has(it.id)) it.attempts++
      await writeQueue(cur)
    })
    scheduleRetry()
    return
  }

  // 2xx: every row in the batch was either applied or rejected by the server, so all of them leave the queue.
  failures = 0
  lastError.value = null
  await locked(async () => {
    const cur = await readQueue()
    const ids = new Set(batch.map((b) => b.id))
    await writeQueue(cur.filter((it) => !ids.has(it.id)))
  })
  for (const r of res.rejected ?? []) for (const h of rejectHooks) h(r.table, r.key, r.reason)
  status.value = 'idle'
  if ((await readQueue()).length > 0) void flush()
}

let started = false
/** Wire the flush triggers once: start, online, visibility. */
export function startOutbox(): void {
  if (started) return
  started = true
  void readQueue().then((q) => { pending.value = q.length })
  window.addEventListener('online', () => void flush())
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void flush() })
  void flush()
}
