// M3 food: foods, meals, food log, nutrition lookups. Routes are registered by spreading this array into ROUTES in ../index.ts.
// Reads aggregate in SQL (one env.DB.batch() per request); the two POSTs are the Claude Code helpers (`planner food add`,
// `planner eat`) — the app itself writes these tables through POST /api/write.
import type { Route, RouteContext } from '../env'
import { HttpError, json } from '../http'
import { readJson } from '../http'
import { upsertFor } from '../db'
import { isCalendarDay } from '../router'
import { localDay } from '../../shared/tz'
import type { Food, FoodLog, Meal, MealItem } from '../../shared/types'
import {
  buildLogRow, candidatesFromSearch, gtinSpellings, likePattern, matchBarcode, parseFoodBody, parseLimit, parseLogBody, pickByName, slotFor,
  totalsFromRow, usdaSearchBody, type LogTotals, type LookupType,
} from './food/helpers'
import { DEMO_KEY, usdaSearch } from './food/usda'

function rows<T>(r: D1Result<unknown> | undefined): T[] {
  return (r?.results ?? []) as T[]
}

const FOODS_SQL = 'SELECT * FROM foods WHERE deleted_at IS NULL'
const FOODS_ORDER = ' ORDER BY use_count DESC, last_used_at DESC, name COLLATE NOCASE LIMIT ?'
const MEALS_SQL = 'SELECT * FROM meals WHERE deleted_at IS NULL ORDER BY use_count DESC, last_used_at DESC, name COLLATE NOCASE'
const MEAL_ITEMS_SQL = 'SELECT mi.* FROM meal_items mi JOIN meals m ON m.id = mi.meal_id WHERE mi.deleted_at IS NULL AND m.deleted_at IS NULL ORDER BY mi.meal_id, mi.position'
const LOG_SQL = 'SELECT * FROM food_log WHERE local_day = ? AND deleted_at IS NULL ORDER BY ts, created_at'
const SUMS = 'SUM(kcal) AS kcal, SUM(protein_g) AS protein_g, SUM(carb_g) AS carb_g, SUM(fat_g) AS fat_g, SUM(fiber_g) AS fiber_g, SUM(sugar_g) AS sugar_g'
const TOTALS_SQL = `SELECT ${SUMS} FROM food_log WHERE local_day = ? AND deleted_at IS NULL`
const BY_SLOT_SQL = `SELECT slot, ${SUMS} FROM food_log WHERE local_day = ? AND deleted_at IS NULL GROUP BY slot`
const BUMP_FOOD_SQL = 'UPDATE foods SET use_count = use_count + 1, last_used_at = ? WHERE id = ?'
const BUMP_MEAL_SQL = 'UPDATE meals SET use_count = use_count + 1, last_used_at = ? WHERE id = ?'
const DIRTY_SQL = 'INSERT INTO dirty_days (local_day, marked_at) VALUES (?, ?) ON CONFLICT(local_day) DO UPDATE SET marked_at = excluded.marked_at'
const MAX_LIMIT = 1000

/** GET /api/foods?q=&limit=50 — non-deleted foods, most used first; q filters name/brand with LIKE. */
async function listFoods({ env, url }: RouteContext): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim()
  const limit = parseLimit(url.searchParams.get('limit'), 50, MAX_LIMIT)
  const stmt = q
    ? env.DB.prepare(`${FOODS_SQL} AND (name LIKE ? ESCAPE '\\' OR brand LIKE ? ESCAPE '\\')${FOODS_ORDER}`).bind(likePattern(q), likePattern(q), limit)
    : env.DB.prepare(`${FOODS_SQL}${FOODS_ORDER}`).bind(limit)
  const { results } = await stmt.all<Food>()
  return json({ foods: results })
}

/** GET /api/meals — every live meal with its live items. */
async function listMeals({ env }: RouteContext): Promise<Response> {
  const [mealsR, itemsR] = await env.DB.batch([env.DB.prepare(MEALS_SQL), env.DB.prepare(MEAL_ITEMS_SQL)])
  return json({ meals: rows<Meal>(mealsR), items: rows<MealItem>(itemsR) })
}

/** GET /api/food-log?day=YYYY-MM-DD (default today) — the day's entries plus SQL totals overall and per slot. */
async function foodLogDay({ env, url, now }: RouteContext): Promise<Response> {
  const raw = (url.searchParams.get('day') ?? 'today').trim().toLowerCase()
  const day = raw === 'today' || raw === '' ? localDay(now, env.TZ) : raw
  if (!isCalendarDay(day)) throw new HttpError(400, 'day must be YYYY-MM-DD or today')
  const db = env.DB
  const [entriesR, totalsR, slotsR] = await db.batch([
    db.prepare(LOG_SQL).bind(day), db.prepare(TOTALS_SQL).bind(day), db.prepare(BY_SLOT_SQL).bind(day),
  ])
  const by_slot: Record<string, LogTotals> = {}
  for (const r of rows<Record<string, unknown>>(slotsR)) by_slot[String(r['slot'])] = totalsFromRow(r)
  return json({ day, entries: rows<FoodLog>(entriesR), totals: totalsFromRow(rows<Record<string, unknown>>(totalsR)[0]), by_slot })
}

/** POST /api/foods — Claude Code helper: per-serving or per-100 g numbers -> a per-100 g foods row (+ 4/4/9 warnings). */
async function createFood(c: RouteContext): Promise<Response> {
  const { row, warnings } = parseFoodBody(await readJson<unknown>(c.request), c.now)
  const u = upsertFor('foods', row) // guarded: a newer row already there (edited in the app) is not reverted
  await c.env.DB.prepare(u.sql).bind(...u.params).run()
  const { results } = await c.env.DB.prepare('SELECT * FROM foods WHERE id = ?').bind(row.id).all<Food>()
  return json({ food: results[0] ?? row, warnings }, 201)
}

/** POST /api/food-log — Claude Code helper: {food_id|food_name|meal_id|meal_name, grams|scale, at?, slot?, note?} -> a snapshotted entry. */
async function createFoodLog(c: RouteContext): Promise<Response> {
  const { env, now } = c
  const tz = env.TZ
  const body = parseLogBody(await readJson<unknown>(c.request), now, tz)
  const db = env.DB
  const t = body.target
  const table = t.kind === 'food' ? 'foods' : 'meals'
  const stmt = t.id
    ? db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL LIMIT 1`).bind(t.id)
    : db.prepare(`SELECT * FROM ${table} WHERE name LIKE ? ESCAPE '\\' AND deleted_at IS NULL ORDER BY use_count DESC, last_used_at DESC LIMIT 6`).bind(likePattern(t.name ?? ''))
  const { results } = await stmt.all<Food | Meal>()
  let picked: Food | Meal
  if (t.id) {
    const hit = results[0]
    if (!hit) throw new HttpError(400, `no ${t.kind} with id ${t.id}`)
    picked = hit
  } else {
    picked = pickByName(results, t.name ?? '', t.kind)
  }
  const slot = slotFor(body.at, tz, body.slot)
  const entry = buildLogRow({
    food: t.kind === 'food' ? (picked as Food) : undefined,
    meal: t.kind === 'meal' ? (picked as Meal) : undefined,
    grams: body.grams, scale: body.scale, at: body.at, slot, note: body.note, tz, now,
  })
  const u = upsertFor('food_log', entry, false)
  const nowIso = now.toISOString()
  const writes = [
    db.prepare(u.sql).bind(...u.params),
    db.prepare(t.kind === 'food' ? BUMP_FOOD_SQL : BUMP_MEAL_SQL).bind(nowIso, picked.id),
  ]
  if (entry.local_day < localDay(now, tz)) writes.push(db.prepare(DIRTY_SQL).bind(entry.local_day, nowIso))
  await db.batch(writes)
  return json({ entry }, 201)
}

function usdaKey(env: RouteContext['env']): { key: string; demo: boolean } {
  const key = (env.USDA_KEY ?? '').trim()
  return key ? { key, demo: false } : { key: DEMO_KEY, demo: true }
}

/** GET /api/lookup/search?q=&type=generic|branded&page=1 — USDA name search (Foundation + SR Legacy, or Branded). */
async function lookupSearch({ env, url }: RouteContext): Promise<Response> {
  const q = (url.searchParams.get('q') ?? '').trim()
  if (!q) throw new HttpError(400, 'q required')
  const typeRaw = (url.searchParams.get('type') ?? 'generic').toLowerCase()
  if (typeRaw !== 'generic' && typeRaw !== 'branded') throw new HttpError(400, 'type must be generic or branded')
  const type: LookupType = typeRaw
  const page = parseLimit(url.searchParams.get('page'), 1, 50)
  const { key, demo } = usdaKey(env)
  const r = await usdaSearch(key, usdaSearchBody(q, type, page))
  if (r.kind === 'rate_limited') return json({ ok: false, error: 'USDA rate limit reached', retry_after: r.retryAfter, demo_key: demo }, 429)
  if (r.kind === 'error') return json({ ok: false, error: r.message, demo_key: demo }, 502)
  return json({ q, type, page, total: r.total, candidates: candidatesFromSearch(r.foods), demo_key: demo })
}

/** GET /api/lookup/barcode/:code — USDA Branded by GTIN; the fallback after the app's direct Open Food Facts call. */
async function lookupBarcode({ env, params }: RouteContext): Promise<Response> {
  const code = (params['code'] ?? '').replace(/\D/g, '')
  if (code.length < 8 || code.length > 14) throw new HttpError(400, 'code must be 8-14 digits')
  const { key, demo } = usdaKey(env)
  // One request, several spellings: USDA matches gtinUpc as an exact token, stored as 12, 13 or 14 digits per product.
  const r = await usdaSearch(key, { query: gtinSpellings(code).join(' '), dataType: ['Branded'], pageSize: 10, pageNumber: 1 })
  if (r.kind === 'rate_limited') return json({ ok: false, error: 'USDA rate limit reached', retry_after: r.retryAfter, demo_key: demo }, 429)
  if (r.kind === 'error') return json({ ok: false, error: r.message, demo_key: demo }, 502)
  const candidate = matchBarcode(r.foods, code)
  return json({ code, candidate, source: candidate ? 'usda' : null, demo_key: demo })
}

export const foodRoutes: readonly Route[] = [
  { method: 'GET', path: '/api/foods', roles: ['app'], handler: listFoods },
  { method: 'POST', path: '/api/foods', roles: ['app'], handler: createFood },
  { method: 'GET', path: '/api/meals', roles: ['app'], handler: listMeals },
  { method: 'GET', path: '/api/food-log', roles: ['app'], handler: foodLogDay },
  { method: 'POST', path: '/api/food-log', roles: ['app'], handler: createFoodLog },
  { method: 'GET', path: '/api/lookup/search', roles: ['app'], handler: lookupSearch },
  { method: 'GET', path: '/api/lookup/barcode/:code', roles: ['app'], handler: lookupBarcode },
]
