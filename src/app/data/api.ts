// Thin API client: bearer token (localStorage, mirrored to IndexedDB), network-first GETs with a cached fallback.
import { signal } from '@preact/signals'
import { del, get, set } from 'idb-keyval'

const TOKEN_KEY = 'planner.token'
const CACHE_PREFIX = 'cache:'

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, message: string, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/** The app token, or null when none is stored. */
export const token = signal<string | null>(readLocalToken())
/** True after any request answered 401 with the current token. Reset when the token changes. */
export const authFailed = signal(false)
/** True when the most recent GET was served from the IndexedDB cache because the network failed. */
export const offline = signal(false)

function readLocalToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

/** Restore the token from IndexedDB when localStorage was cleared (iOS evicts it more eagerly). */
export async function loadToken(): Promise<string | null> {
  if (token.value) return token.value
  try {
    const t = await get<string>(TOKEN_KEY)
    if (t) {
      token.value = t
      try { localStorage.setItem(TOKEN_KEY, t) } catch { /* private mode */ }
    }
  } catch { /* no IndexedDB */ }
  return token.value
}

export function setToken(t: string | null): void {
  const clean = t?.trim() || null
  token.value = clean
  authFailed.value = false
  try {
    if (clean) localStorage.setItem(TOKEN_KEY, clean)
    else localStorage.removeItem(TOKEN_KEY)
  } catch { /* ignore */ }
  void (clean ? set(TOKEN_KEY, clean) : del(TOKEN_KEY)).catch(() => {})
}

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (json) h['Content-Type'] = 'application/json'
  if (token.value) h.Authorization = `Bearer ${token.value}`
  return h
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

function errorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    for (const k of ['message', 'error']) if (typeof b[k] === 'string') return b[k] as string
  }
  if (typeof body === 'string' && body.length < 200) return body
  return status === 401 ? 'Unauthorized' : status === 403 ? 'Forbidden' : status === 404 ? 'Not found' : `HTTP ${status}`
}

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: headers(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const data = await parse(res)
  if (res.status === 401) authFailed.value = true
  if (!res.ok) throw new ApiError(res.status, errorMessage(res.status, data), data)
  return data as T
}

export interface GetResult<T> { data: T; cached: boolean; fetchedAt: string }

/**
 * Network-first GET. On success the response is cached under `cacheKey`; when the network fails
 * the cached copy (if any) is returned with `cached: true` and the `offline` flag is raised.
 * Authorization failures (401/403) are never masked by the cache.
 */
export async function apiGet<T>(path: string, cacheKey: string): Promise<GetResult<T>> {
  try {
    const data = await request<T>('GET', path)
    offline.value = false
    const fetchedAt = new Date().toISOString()
    void set(CACHE_PREFIX + cacheKey, { data, fetchedAt }).catch(() => {})
    return { data, cached: false, fetchedAt }
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) throw err
    const hit = await readCache<T>(cacheKey)
    if (hit) {
      offline.value = true
      return { data: hit.data, cached: true, fetchedAt: hit.fetchedAt }
    }
    throw err
  }
}

export async function readCache<T>(cacheKey: string): Promise<{ data: T; fetchedAt: string } | null> {
  try {
    const hit = await get<{ data: T; fetchedAt: string }>(CACHE_PREFIX + cacheKey)
    return hit ?? null
  } catch {
    return null
  }
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return request<T>('POST', path, body)
}

export function hasToken(): boolean {
  return !!token.value
}
