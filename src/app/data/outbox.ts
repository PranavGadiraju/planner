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
/** A batch the server refused for good (4xx). Kept under 'outbox:dead' so nothing silently disappears. */
export interface DeadItem extends OutboxItem { reason: string; died_at: string }

const KEY = 'outbox'
const DEAD_KEY = 'outbox:dead'
const DEAD_MAX = 200
const MAX_BATCH = 200
const BACKOFF_MS = [2_000, 10_000, 60_000] as const

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'unauthorized'

/** Rows waiting to be written. */
export const pending = signal(0)
export const status = signal<SyncStatus>('idle')
export const lastError = signal<string | null>(null)

type EnqueueHook = (table: string, row: Record<string, unknown>) => void
type RejectHook = (table: string, key: string, reason: string) => void
type FlushHook = (items: OutboxItem[]) => void
const enqueueHooks: EnqueueHook[] = []
const rejectHooks: RejectHook[] = []
const flushHooks: FlushHook[] = []

/** Called synchronously on every enqueue so the store can apply the row optimistically. */
export function onEnqueue(fn: EnqueueHook): () => void {
  enqueueHooks.push(fn)
  return () => { const i = enqueueHooks.indexOf(fn); if (i >= 0) enqueueHooks.splice(i, 1) }
}
/** Called when the server rejects a row or a whole batch (it is dropped from the queue). */
export function onReject(fn: RejectHook): () => void {
  rejectHooks.push(fn)
  return () => { const i = rejectHooks.indexOf(fn); if (i >= 0) rejectHooks.splice(i, 1) }
}
/** Called after a batch was accepted by the server (2xx), with the items that left the queue. */
export function onFlushed(fn: FlushHook): () => void {
  flushHooks.push(fn)
  return () => { const i = flushHooks.indexOf(fn); if (i >= 0) flushHooks.splice(i, 1) }
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

/** Batches the server refused (newest last, capped at 200). Shown in the cache export; nothing retries them. */
export async function deadLetters(): Promise<DeadItem[]> {
  try {
    const d = await get<DeadItem[]>(DEAD_KEY)
    return Array.isArray(d) ? d : []
  } catch {
    return []
  }
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

/** 401 / 403 mean the token (or its role) is wrong: stop and wait for a new token rather than dropping data. */
function isAuthFailure(status: number): boolean {
  return status === 401 || status === 403
}
/** Other 4xx answers will never succeed on retry (bad rows, oversize batch); 408 and 429 are transient. */
function isPermanent(status: number): boolean {
  return status >= 400 && status < 500 && !isAuthFailure(status) && status !== 408 && status !== 429
}

/** A short human key for a row: its id, settings key, or (local_day, item) pair. */
function rowKey(row: Record<string, unknown>): string {
  for (const k of ['id', 'key', 'night_of']) if (typeof row[k] === 'string') return String(row[k])
  if (typeof row.local_day === 'string') return typeof row.item_id === 'string' ? `${row.local_day}/${row.item_id}` : row.local_day
  return '?'
}

async function bury(batch: OutboxItem[], reason: string): Promise<void> {
  const diedAt = new Date().toISOString()
  await locked(async () => {
    const cur = await readQueue()
    const ids = new Set(batch.map((b) => b.id))
    const dead = await deadLetters()
    for (const it of cur) if (ids.has(it.id)) dead.push({ ...it, reason, died_at: diedAt })
    try { await set(DEAD_KEY, dead.slice(-DEAD_MAX)) } catch { /* ignore */ }
    await writeQueue(cur.filter((it) => !ids.has(it.id)))
  })
  // One notice per table, naming the row when there is only one.
  const byTable = new Map<string, OutboxItem[]>()
  for (const it of batch) byTable.set(it.table, [...(byTable.get(it.table) ?? []), it])
  for (const [table, items] of byTable) {
    const key = items.length === 1 && items[0] ? rowKey(items[0].row) : `${items.length} rows`
    for (const h of rejectHooks) h(table, key, reason)
  }
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
    if (err instanceof ApiError && isAuthFailure(err.status)) {
      status.value = 'unauthorized'
      lastError.value = err.status === 403 ? 'Token has the wrong role' : 'Token rejected'
      authFailed.value = true
      return // stop until the token changes; the store flushes again when it does
    }
    if (err instanceof ApiError && isPermanent(err.status)) {
      // The server will keep saying no: park the batch, tell the user, move on to the rest of the queue.
      await bury(batch, err.message)
      lastError.value = err.message
      status.value = 'idle'
      if ((await readQueue()).length > 0) void flush()
      return
    }
    // Network errors, 5xx, 408, 429: keep the batch and back off.
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
  for (const h of flushHooks) h(batch)
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
