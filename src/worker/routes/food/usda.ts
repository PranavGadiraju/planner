// USDA FoodData Central client for the Worker (the key never reaches the phone). One POST to /foods/search with a
// 15 s timeout; 429 is surfaced as such so the app can show "try again in a minute".
import { errorMessage } from '../../http'

export const USDA_SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search'
export const USDA_TIMEOUT_MS = 15_000
export const DEMO_KEY = 'DEMO_KEY'

export type UsdaResult =
  | { kind: 'ok'; foods: unknown[]; total: number }
  | { kind: 'rate_limited'; retryAfter: number }
  | { kind: 'error'; status: number; message: string }

export async function usdaSearch(key: string, body: Record<string, unknown>, timeoutMs = USDA_TIMEOUT_MS): Promise<UsdaResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${USDA_SEARCH_URL}?api_key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'))
      return { kind: 'rate_limited', retryAfter: Number.isFinite(ra) && ra > 0 ? ra : 60 }
    }
    if (!res.ok) return { kind: 'error', status: res.status, message: `USDA answered ${res.status}` }
    const data = (await res.json()) as { foods?: unknown; totalHits?: unknown }
    return { kind: 'ok', foods: Array.isArray(data.foods) ? data.foods : [], total: Number(data.totalHits ?? 0) || 0 }
  } catch (e) {
    return { kind: 'error', status: 0, message: ctrl.signal.aborted ? `USDA timed out after ${Math.round(timeoutMs / 1000)} s` : errorMessage(e) }
  } finally {
    clearTimeout(timer)
  }
}
