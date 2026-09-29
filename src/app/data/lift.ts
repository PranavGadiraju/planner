// Lift data: pure rules (pre-fill, PR detection, set numbering, template order) at the top, then the signals,
// the cached loaders and the write helpers that push idempotent rows through the outbox and keep the active
// workout, the Today running strip and the history list in step optimistically.
import { effect, signal } from '@preact/signals'
import { del, get, set } from 'idb-keyval'
import type { Exercise, SetRow, Workout } from '@shared/types'
import { epley1RM } from '@shared/nutrition'
import { localDay } from '@shared/tz'
import { ApiError, apiGet } from './api'
import * as outbox from './outbox'
import { settings, today, tz } from './store'
import { uuid } from './format'

// ---- API shapes (mirrors src/worker/routes/lift/logic.ts) ------------------------------------------

export type HistoryRange = '1m' | '3m' | '1y' | 'all'
export const HISTORY_RANGES: readonly HistoryRange[] = ['1m', '3m', '1y', 'all']
export interface WorkoutSummary extends Workout { sets_count: number; volume: number; exercises_count: number }
export interface SetWithPrior extends SetRow { prior_best: number | null }
export interface WorkoutDetail { workout: Workout; sets: SetWithPrior[]; exercises: Exercise[] }
export interface TemplatePayload { workout: Workout | null; sets: SetRow[]; exercises: Exercise[] }
export interface LastSet extends SetRow { local_day: string; workout_name: string | null }
export interface WorkoutBest { workout_id: string; best: number }
/** Fetched without excluding the running workout (one complete cache entry per exercise); bests = top two workouts. */
export interface LastSetsPayload { sets: LastSet[]; best_e1rm: number | null; bests: WorkoutBest[] }
export interface HistorySet { id: string; set_no: number; reps: number; weight: number; is_warmup: number; ts: string }
export interface HistorySession {
  workout_id: string; local_day: string; started_at: string; name: string | null
  sets: HistorySet[]; best_e1rm: number | null; volume: number; total_reps: number
  top_set: { reps: number; weight: number } | null; is_pr: boolean
}
export interface HistoryPayload { exercise: Exercise; range: HistoryRange; sessions: HistorySession[] }

// ---- pure rules --------------------------------------------------------------------------------------

type SetLike = Pick<SetRow, 'reps' | 'weight' | 'is_warmup'>
export interface RepsWeight { reps: number; weight: number }
export const DEFAULT_PREFILL: RepsWeight = { reps: 8, weight: 0 }
export type PrefillSource = 'template' | 'previous' | 'last' | 'default'

const r1 = (n: number) => Math.round(n * 10) / 10
const live = (s: { deleted_at: string | null }) => !s.deleted_at
const bySetOrder = (a: SetRow, b: SetRow) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.set_no - b.set_no)

/**
 * Pre-fill for set N of exercise E: the last same-name workout's set N of E; else set N-1 (the highest logged set
 * below N) of this workout; else E's last logged set ever; else 8 x 0.
 */
export function prefillSet(
  setNo: number,
  input: { templateSets: readonly SetRow[]; currentSets: readonly SetRow[]; lastEver: readonly SetRow[] },
): RepsWeight & { source: PrefillSource } {
  const tpl = input.templateSets.find((s) => live(s) && s.set_no === setNo)
  if (tpl) return { reps: tpl.reps, weight: tpl.weight, source: 'template' }
  let prev: SetRow | undefined
  for (const s of input.currentSets) if (live(s) && s.set_no < setNo && (!prev || s.set_no > prev.set_no)) prev = s
  if (prev) return { reps: prev.reps, weight: prev.weight, source: 'previous' }
  const last = input.lastEver.find(live)
  if (last) return { reps: last.reps, weight: last.weight, source: 'last' }
  return { ...DEFAULT_PREFILL, source: 'default' }
}

/** Best Epley e1RM over the non-warm-up (live) sets, or null. */
export function bestE1rm(sets: readonly (SetLike & { deleted_at?: string | null })[]): number | null {
  let best: number | null = null
  for (const s of sets) {
    if (s.is_warmup || s.deleted_at) continue
    const e = epley1RM(s.weight, s.reps)
    if (best === null || e > best) best = e
  }
  return best
}

/** A logged set is a PR when it is a working set whose e1RM beats every earlier working set of that exercise. */
export function isPR(s: SetLike, priorBest: number | null): boolean {
  if (s.is_warmup || s.reps < 1) return false
  const e = epley1RM(s.weight, s.reps)
  return priorBest === null ? e > 0 : e > priorBest
}

/** Next set_no for (workout, exercise): one past the highest live set_no (a deleted last set frees its number). */
export function nextSetNo(sets: readonly SetRow[], workoutId: string, exerciseId: string): number {
  let max = 0
  for (const s of sets) if (live(s) && s.workout_id === workoutId && s.exercise_id === exerciseId && s.set_no > max) max = s.set_no
  return max + 1
}

/** Distinct exercise ids in the order they were first performed (by ts, then set_no). */
export function templateExerciseOrder(sets: readonly SetRow[]): string[] {
  const out: string[] = []
  for (const s of [...sets].filter(live).sort(bySetOrder)) if (!out.includes(s.exercise_id)) out.push(s.exercise_id)
  return out
}

export function normName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** The last `max` distinct workout names by recency (case-insensitive, trimmed, blanks skipped). */
export function templateNames(workouts: readonly Workout[], max = 5): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const w of [...workouts].filter(live).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))) {
    const name = (w.name ?? '').trim()
    if (!name) continue
    const k = normName(name)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(name)
    if (out.length >= max) break
  }
  return out
}

/** Case-insensitive, trimmed name match; null when there is no such exercise (so the UI can offer "Create"). */
export function findExerciseByName(list: readonly Exercise[], name: string): Exercise | null {
  const k = normName(name)
  if (!k) return null
  return list.find((e) => !e.deleted_at && normName(e.name) === k) ?? null
}

export interface WorkoutStats { sets: number; volume: number; exercises: number }
/** Working (non-warm-up, live) set count, volume and distinct exercises, matching the Worker's aggregates. */
export function workoutStats(sets: readonly SetRow[]): WorkoutStats {
  let n = 0
  let volume = 0
  const ex = new Set<string>()
  for (const s of sets) {
    if (!live(s) || s.is_warmup) continue
    n++
    volume += s.reps * s.weight
    ex.add(s.exercise_id)
  }
  return { sets: n, volume: r1(volume), exercises: ex.size }
}

export function fmtWeight(n: number): string {
  return Number(n.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits: 2 })
}
export function fmtVolume(n: number, unit: string): string {
  return `${Math.round(n).toLocaleString('en-US')} ${unit}`
}
export function fmtMinutes(min: number): string {
  const m = Math.max(0, Math.round(min))
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
/** "52 min · 18 sets · 7,420 lb · 2 PRs"; with no stats at hand (nothing local or cached) just the duration. */
export function summaryLine(minutes: number, stats: WorkoutStats | null, prs: number, unit: string): string {
  const parts = [fmtMinutes(minutes)]
  if (stats) parts.push(`${stats.sets} set${stats.sets === 1 ? '' : 's'}`, fmtVolume(stats.volume, unit))
  if (prs > 0) parts.push(`${prs} PR${prs === 1 ? '' : 's'}`)
  return parts.join(' · ')
}
/** "Push · Tue 24 Sep · 52 min · 18 sets · 7,420 lb" pieces after the name/date, for history rows. */
export function workoutMinutes(w: Pick<Workout, 'started_at' | 'ended_at'>, now: Date): number {
  const end = w.ended_at ? new Date(w.ended_at).getTime() : now.getTime()
  return (end - new Date(w.started_at).getTime()) / 60000
}

export const AUTO_CLOSE_MS = 3 * 3600_000
/** Where a forgotten workout ends: 2 min after its last set (or 2 min after it started when nothing was logged). */
export function autoCloseEnd(w: Pick<Workout, 'started_at'>, sets: readonly SetRow[]): string {
  let last = w.started_at
  for (const s of sets) if (live(s) && s.ts > last) last = s.ts
  return new Date(new Date(last).getTime() + 120_000).toISOString()
}

/** The most recent earlier session of an exercise (from last-sets), oldest set first, for the ghost line. */
export function lastSessionSets(p: LastSetsPayload | undefined, excludeWorkoutId: string | null): { day: string; sets: LastSet[] } | null {
  if (!p) return null
  const first = p.sets.find((s) => live(s) && s.workout_id !== excludeWorkoutId)
  if (!first) return null
  const sets = p.sets.filter((s) => live(s) && s.workout_id === first.workout_id).sort((a, b) => a.set_no - b.set_no)
  return { day: first.local_day, sets }
}

/**
 * The server's best e1RM of an exercise outside `excludeWorkoutId` (null: no other workout has a working set). The
 * payload covers every workout, so bests[] (top two) makes the exclusion exact without a per-workout request or cache.
 */
export function serverBestFor(p: LastSetsPayload, excludeWorkoutId: string | null): number | null {
  if (!Array.isArray(p.bests)) return p.best_e1rm ?? null // a copy cached by an older build
  return p.bests.find((b) => b.workout_id !== excludeWorkoutId)?.best ?? null
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export function monthLabel(localDayStr: string): string {
  const [y, m] = localDayStr.split('-')
  return `${MONTHS[Number(m) - 1] ?? ''} ${y ?? ''}`.trim()
}

// ---- state ---------------------------------------------------------------------------------------------

export interface ActiveState {
  workout: Workout
  /** Pager order, including exercises that have no set yet (a template pre-populates them). */
  exercise_ids: string[]
  /** Live sets of this workout, every exercise, in (ts, set_no) order. */
  sets: SetRow[]
  /** Ids of sets that were PRs when logged. */
  pr_ids: string[]
}

export const active = signal<ActiveState | null>(null)
export const exercises = signal<Exercise[]>([])
export const workouts = signal<WorkoutSummary[]>([])
/** False once a page came back short, so the history stops offering "older". */
export const workoutsMore = signal(true)
export const workoutsLoading = signal(false)
export const workoutsError = signal<string | null>(null)
export const workoutsCached = signal(false)
/** Last-sets payload per exercise id (used for the ghost line, the best e1RM and PR detection). */
export const lastSets = signal<Record<string, LastSetsPayload>>({})
const templates = new Map<string, TemplatePayload>()

const ACTIVE_KEY = 'lift:active'
let activeLoad: Promise<void> | null = null
/** Restore the active workout from IndexedDB once (the PWA reloads whenever the phone locks long enough). */
export function ensureActive(): Promise<void> {
  if (!activeLoad) {
    activeLoad = (async () => {
      if (active.value) return
      try {
        const a = await get<ActiveState>(ACTIVE_KEY)
        if (a && a.workout && !a.workout.ended_at && !a.workout.deleted_at && !active.value) active.value = a
      } catch { /* no IndexedDB */ }
    })()
  }
  return activeLoad
}
function persistActive(): void {
  const a = active.value
  try { void (a ? set(ACTIVE_KEY, a) : del(ACTIVE_KEY)).catch(() => {}) } catch { /* IndexedDB unavailable */ }
}
/** Drop the IndexedDB copy of `workoutId` when it is the one persisted there (a workout finished from Today after a reload). */
async function clearPersistedActive(workoutId: string): Promise<void> {
  try {
    const p = await get<ActiveState>(ACTIVE_KEY)
    if (p?.workout?.id === workoutId) await del(ACTIVE_KEY)
  } catch { /* no IndexedDB */ }
}

const sortExercises = (list: Exercise[]) =>
  list.filter(live).sort((a, b) => b.use_count - a.use_count || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

// ---- loaders (network-first, IndexedDB fallback via apiGet) --------------------------------------------

async function replayQueued(table: string, fn: (row: Record<string, unknown>) => void): Promise<void> {
  for (const it of await outbox.peek()) if (it.table === table) fn(it.row)
}

export async function loadExercises(): Promise<void> {
  const r = await apiGet<{ exercises: Exercise[] }>('/api/exercises', 'exercises')
  let list = r.data.exercises
  await replayQueued('exercises', (row) => { list = upsertById(list, row as unknown as Exercise) })
  exercises.value = sortExercises(list)
}

const PAGE = 50
export async function loadWorkouts(older = false): Promise<void> {
  const oldest = workouts.value[workouts.value.length - 1]
  const before = older && oldest ? oldest.started_at : null
  workoutsLoading.value = true
  try {
    const path = before ? `/api/workouts?limit=${PAGE}&before=${encodeURIComponent(before)}` : `/api/workouts?limit=${PAGE}`
    const r = await apiGet<{ workouts: WorkoutSummary[] }>(path, before ? `workouts:${before}` : 'workouts')
    let list = before ? [...workouts.value, ...r.data.workouts] : r.data.workouts
    await replayQueued('workouts', (row) => { list = mergeWorkoutSummary(list, row as unknown as Workout) })
    workouts.value = list.filter(live).sort((a, b) => (a.started_at < b.started_at ? 1 : -1))
    workoutsMore.value = r.data.workouts.length >= PAGE
    workoutsCached.value = r.cached
    workoutsError.value = null
  } catch (err) {
    workoutsError.value = err instanceof ApiError ? err.message : 'Cannot reach the server'
  } finally {
    workoutsLoading.value = false
  }
}

/** The last finished workout with this name (or null); cached in memory for the session and in IndexedDB. */
export async function loadTemplate(name: string | null): Promise<TemplatePayload | null> {
  const key = name ? normName(name) : ''
  if (!key) return null
  const hit = templates.get(key)
  if (hit) return hit
  const r = await apiGet<TemplatePayload>(`/api/lift/template?name=${encodeURIComponent(name ?? '')}`, `template:${key}`)
  templates.set(key, r.data)
  return r.data
}

/**
 * The last 10 working sets and the best e1RM per workout of an exercise, every workout included: the one cache entry
 * per exercise is then complete offline (the running workout is skipped by lastSessionSets / serverBestFor instead).
 */
export async function loadLastSets(exerciseId: string): Promise<LastSetsPayload | null> {
  try {
    const r = await apiGet<LastSetsPayload>(`/api/lift/last-sets?exercise_id=${encodeURIComponent(exerciseId)}`, `lastsets:${exerciseId}`)
    lastSets.value = { ...lastSets.value, [exerciseId]: r.data }
    return r.data
  } catch {
    return lastSets.value[exerciseId] ?? null
  }
}

export function loadWorkoutDetail(id: string): Promise<{ data: WorkoutDetail; cached: boolean }> {
  return apiGet<WorkoutDetail>(`/api/workouts/${encodeURIComponent(id)}`, `workout:${id}`)
}

export function loadHistory(exerciseId: string, range: HistoryRange): Promise<{ data: HistoryPayload; cached: boolean }> {
  return apiGet<HistoryPayload>(`/api/exercises/${encodeURIComponent(exerciseId)}/history?range=${range}`, `history:${exerciseId}:${range}`)
}

// ---- write helpers ------------------------------------------------------------------------------------

const nowIso = () => new Date().toISOString()
const enqueue = (table: string, row: object) => outbox.enqueue(table, row as Record<string, unknown>)

/** Create a workout now; a template pre-populates its exercise pages (no sets). Returns the row. */
export async function startWorkout(name: string | null, template: TemplatePayload | null = null): Promise<Workout> {
  const ts = nowIso()
  const clean = name?.trim() || null
  const workout: Workout = {
    id: uuid(), name: clean, started_at: ts, ended_at: null, local_day: localDay(ts, tz.value), note: null, ended_by: null,
    created_at: ts, updated_at: ts, deleted_at: null,
  }
  const exercise_ids = template ? templateExerciseOrder(template.sets) : []
  if (template && clean) templates.set(normName(clean), template)
  active.value = { workout, exercise_ids, sets: [], pr_ids: [] }
  persistActive()
  await enqueue('workouts', workout)
  for (const id of exercise_ids) void loadLastSets(id) // warm the cache for the gym
  return workout
}

export type OpenResult = 'active' | 'finished' | 'missing' | 'offline'

/**
 * Make `id` the active workout: from memory / IndexedDB when it is already ours, else from the server (a workout
 * started on the other device). When online, the server copy is merged in so both devices agree; a workout that
 * was finished elsewhere returns 'finished'.
 */
export async function openWorkout(id: string): Promise<OpenResult> {
  await ensureActive()
  const mine = active.value?.workout.id === id ? active.value : null
  let detail: { data: WorkoutDetail; cached: boolean } | null = null
  try {
    detail = await loadWorkoutDetail(id)
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return mine ? 'active' : 'missing'
    return mine ? 'active' : 'offline'
  }
  if (detail.cached && mine) return 'active'
  const w = detail.data.workout
  if (w.ended_at || w.deleted_at) {
    if (mine) { active.value = null; persistActive() }
    return 'finished'
  }
  const serverSets = detail.data.sets
  let sets: SetRow[] = serverSets.map(({ prior_best: _p, ...s }) => s)
  const pr_ids = serverSets.filter((s) => isPR(s, s.prior_best)).map((s) => s.id)
  await replayQueued('sets', (row) => { const s = row as unknown as SetRow; if (s.workout_id === id) sets = upsertById(sets, s) })
  sets = sets.filter(live).sort(bySetOrder)
  const order = templateExerciseOrder(sets)
  const exercise_ids = mine ? [...mine.exercise_ids, ...order.filter((e) => !mine.exercise_ids.includes(e))] : order
  for (const s of sets) if (!pr_ids.includes(s.id) && mine?.pr_ids.includes(s.id)) pr_ids.push(s.id)
  active.value = { workout: mine?.workout.updated_at && mine.workout.updated_at > w.updated_at ? mine.workout : w, exercise_ids, sets, pr_ids }
  persistActive()
  for (const eid of exercise_ids) void loadLastSets(eid)
  return 'active'
}

/** Append an exercise page to the active workout (no-op when it is already there). */
export function addExerciseToWorkout(exerciseId: string): void {
  const a = active.value
  if (!a || a.exercise_ids.includes(exerciseId)) return
  active.value = { ...a, exercise_ids: [...a.exercise_ids, exerciseId] }
  persistActive()
  void loadLastSets(exerciseId)
}

export function removeExerciseFromWorkout(exerciseId: string): void {
  const a = active.value
  if (!a) return
  active.value = { ...a, exercise_ids: a.exercise_ids.filter((e) => e !== exerciseId) }
  persistActive()
}

export interface ExercisePatch { name?: string; muscle?: string | null; load_type?: Exercise['load_type']; weight_step?: number }

/** Create an exercise (the UI only calls this after an explicit "Create <name>"; near-duplicates are matched first). */
export async function createExercise(name: string, patch: ExercisePatch = {}): Promise<Exercise> {
  const ts = nowIso()
  const row: Exercise = {
    id: uuid(), name: name.trim().replace(/\s+/g, ' '), muscle: patch.muscle?.trim() || null, load_type: patch.load_type ?? 'weight',
    weight_step: patch.weight_step && patch.weight_step > 0 ? patch.weight_step : 5, use_count: 0, last_used_at: null,
    created_at: ts, updated_at: ts, deleted_at: null,
  }
  await enqueue('exercises', row)
  return row
}

export async function updateExercise(ex: Exercise, patch: ExercisePatch): Promise<Exercise> {
  const row: Exercise = {
    ...ex,
    name: patch.name !== undefined ? patch.name.trim().replace(/\s+/g, ' ') || ex.name : ex.name,
    muscle: patch.muscle !== undefined ? patch.muscle?.trim() || null : ex.muscle,
    load_type: patch.load_type ?? ex.load_type,
    weight_step: patch.weight_step && patch.weight_step > 0 ? patch.weight_step : ex.weight_step,
    updated_at: nowIso(),
  }
  await enqueue('exercises', row)
  return row
}

/**
 * The best e1RM of an exercise before `ts`: server history (last-sets, outside this workout) plus this workout's
 * earlier sets. `undefined` while the server side is unknown (fetch still in flight, or offline with no cached copy):
 * "no history yet" and "history not loaded" are different answers, and only the first makes a set a PR.
 */
export function priorBestFor(a: ActiveState, exerciseId: string, ts: string, excludeSetId: string | null = null): number | null | undefined {
  const p = lastSets.value[exerciseId]
  if (!p) return undefined
  const server = serverBestFor(p, a.workout.id)
  const earlier = a.sets.filter((s) => s.exercise_id === exerciseId && s.id !== excludeSetId && s.ts < ts)
  const local = bestE1rm(earlier)
  if (server === null) return local
  if (local === null) return server
  return Math.max(server, local)
}

/**
 * Log the next set of an exercise in the active workout. Returns the row and whether it was a PR; with the exercise's
 * history still unknown the set is logged at once without a PR claim, and the badge is added when the history arrives.
 */
export async function logSet(exerciseId: string, reps: number, weight: number, isWarmup: boolean): Promise<{ set: SetRow; pr: boolean }> {
  const a = active.value
  if (!a) throw new Error('No active workout')
  const ts = nowIso()
  const row: SetRow = {
    id: uuid(), workout_id: a.workout.id, exercise_id: exerciseId, set_no: nextSetNo(a.sets, a.workout.id, exerciseId),
    reps: Math.max(1, Math.round(reps)), weight: Math.max(0, r1(weight)), is_warmup: isWarmup ? 1 : 0, ts, updated_at: ts, deleted_at: null,
  }
  const prior = priorBestFor(a, exerciseId, ts)
  const pr = prior !== undefined && isPR(row, prior)
  const firstOfExercise = !a.sets.some((s) => s.exercise_id === exerciseId)
  if (pr) active.value = { ...a, pr_ids: [...a.pr_ids, row.id] }
  await enqueue('sets', row)
  if (firstOfExercise) {
    const ex = exercises.value.find((e) => e.id === exerciseId)
    if (ex) await enqueue('exercises', { ...ex, use_count: ex.use_count + 1, last_used_at: ts, updated_at: ts })
  }
  if (prior === undefined && !row.is_warmup) void flagWhenKnown(row)
  return { set: row, pr }
}

/** A set logged while its exercise's history was unknown: fetch it (or the cached copy) and add the PR badge if it earned one. */
async function flagWhenKnown(row: SetRow): Promise<void> {
  if (!(await loadLastSets(row.exercise_id))) return
  const a = active.value
  if (!a || a.workout.id !== row.workout_id || a.pr_ids.includes(row.id) || !a.sets.some((s) => s.id === row.id)) return
  const prior = priorBestFor(a, row.exercise_id, row.ts, row.id)
  if (prior === undefined || !isPR(row, prior)) return
  active.value = { ...a, pr_ids: [...a.pr_ids, row.id] }
  persistActive()
}

export async function editSet(s: SetRow, patch: { reps?: number; weight?: number; is_warmup?: boolean }): Promise<SetRow> {
  const row: SetRow = {
    ...s,
    reps: patch.reps !== undefined ? Math.max(1, Math.round(patch.reps)) : s.reps,
    weight: patch.weight !== undefined ? Math.max(0, r1(patch.weight)) : s.weight,
    is_warmup: patch.is_warmup !== undefined ? (patch.is_warmup ? 1 : 0) : s.is_warmup,
    updated_at: nowIso(),
  }
  const a = active.value
  if (a && a.workout.id === row.workout_id) {
    const prior = priorBestFor(a, row.exercise_id, row.ts, row.id)
    if (prior !== undefined) { // history unknown: keep the badge as it was rather than guess
      const pr = isPR(row, prior)
      active.value = { ...a, pr_ids: pr ? [...new Set([...a.pr_ids, row.id])] : a.pr_ids.filter((id) => id !== row.id) }
    }
  }
  await enqueue('sets', row)
  return row
}

export async function deleteSet(s: SetRow): Promise<void> {
  const ts = nowIso()
  await enqueue('sets', { ...s, updated_at: ts, deleted_at: ts })
}

/** stats is null when neither this device nor the server (or its cached copy) could say what was logged. */
export interface FinishSummary { minutes: number; stats: WorkoutStats | null; prs: number; line: string }

/**
 * Finish a workout (default: now). The Today strip, the active state and the history list update at once. The summary
 * counts this device's sets (restored from IndexedDB first: Today's End button runs before the Lift tab ever opened),
 * else the server's copy of a workout run elsewhere; with neither at hand the line is just the duration, never "0 sets".
 */
export async function finishWorkout(w: Workout, endedAt: string = nowIso(), endedBy: 'user' | 'auto' = 'user'): Promise<FinishSummary> {
  await ensureActive()
  const a = active.value?.workout.id === w.id ? active.value : null
  let stats: WorkoutStats | null = null
  let prs = 0
  if (a) {
    stats = workoutStats(a.sets)
    prs = a.pr_ids.filter((id) => a.sets.some((s) => s.id === id && !s.is_warmup)).length
  } else {
    const remote = await remoteStats(w.id)
    if (remote) ({ stats, prs } = remote)
    void clearPersistedActive(w.id)
  }
  const minutes = (new Date(endedAt).getTime() - new Date(w.started_at).getTime()) / 60000
  const row: Workout = { ...w, ended_at: endedAt, ended_by: endedBy, updated_at: nowIso() }
  if (w.name) templates.delete(normName(w.name)) // the next start of this template should see this session
  await enqueue('workouts', row)
  return { minutes, stats, prs, line: summaryLine(minutes, stats, prs, settings.value.weight_unit) }
}

/** Working sets and PRs of a workout this device did not run: the server's detail (or its cached copy) plus anything still queued. */
async function remoteStats(workoutId: string): Promise<{ stats: WorkoutStats; prs: number } | null> {
  try {
    const { data } = await loadWorkoutDetail(workoutId)
    const prIds = new Set(data.sets.filter((s) => isPR(s, s.prior_best)).map((s) => s.id))
    let sets: SetRow[] = data.sets
    await replayQueued('sets', (row) => { const s = row as unknown as SetRow; if (s.workout_id === workoutId) sets = upsertById(sets, s) })
    sets = sets.filter(live)
    return { stats: workoutStats(sets), prs: sets.filter((s) => prIds.has(s.id) && !s.is_warmup).length }
  } catch {
    return null
  }
}

export async function renameWorkout(w: Workout, name: string | null): Promise<void> {
  const clean = name?.trim().replace(/\s+/g, ' ') || null
  if (clean === w.name) return
  await enqueue('workouts', { ...w, name: clean, updated_at: nowIso() })
}

/** Tombstone a workout (its sets stay but every query joins on live workouts, so they vanish with it). */
export async function deleteWorkout(w: Workout): Promise<void> {
  const ts = nowIso()
  if (w.name) templates.delete(normName(w.name))
  await enqueue('workouts', { ...w, updated_at: ts, deleted_at: ts })
}

/** Move every set of `from` (as listed by its full history) onto `into`, then tombstone `from`. Returns the set count. */
export async function mergeExercise(from: Exercise, into: Exercise, sessions: readonly HistorySession[]): Promise<number> {
  const ts = nowIso()
  let n = 0
  for (const sess of sessions) {
    for (const s of sess.sets) {
      const row: SetRow = { id: s.id, workout_id: sess.workout_id, exercise_id: into.id, set_no: s.set_no, reps: s.reps, weight: s.weight, is_warmup: s.is_warmup, ts: s.ts, updated_at: ts, deleted_at: null }
      await enqueue('sets', row)
      n++
    }
  }
  await enqueue('exercises', { ...into, use_count: into.use_count + from.use_count, last_used_at: into.last_used_at ?? from.last_used_at, updated_at: ts })
  await enqueue('exercises', { ...from, updated_at: ts, deleted_at: ts })
  const { [into.id]: _stale, ...rest } = lastSets.value // the target's history changed: re-fetch it next time
  lastSets.value = rest
  return n
}

// ---- optimistic mirror ----------------------------------------------------------------------------------

function upsertById<T extends { id: string; updated_at: string }>(list: readonly T[], row: T): T[] {
  const rest = list.filter((x) => x.id !== row.id)
  const cur = list.find((x) => x.id === row.id)
  return cur && cur.updated_at > row.updated_at ? [...list] : [...rest, row]
}

function mergeWorkoutSummary(list: readonly WorkoutSummary[], w: Workout): WorkoutSummary[] {
  const cur = list.find((x) => x.id === w.id)
  const a = active.value
  const stats = a && a.workout.id === w.id ? workoutStats(a.sets) : null
  const row: WorkoutSummary = {
    ...(cur ?? { sets_count: 0, volume: 0, exercises_count: 0 }),
    ...w,
    ...(stats ? { sets_count: stats.sets, volume: stats.volume, exercises_count: stats.exercises } : {}),
  }
  return upsertById(list, row)
}

/** Workout ids we enqueued and the server may not have seen yet (so a Today refresh cannot hide the running strip). */
const queuedWorkoutIds = new Set<string>()

function applyWorkoutRow(w: Workout): void {
  const a = active.value
  if (a && a.workout.id === w.id) {
    active.value = w.ended_at || w.deleted_at ? null : { ...a, workout: w }
    persistActive()
  }
  const p = today.value
  if (p) {
    if (!w.ended_at && !w.deleted_at) today.value = { ...p, running: { ...p.running, workout: w } }
    else if (p.running.workout?.id === w.id) today.value = { ...p, running: { ...p.running, workout: null } }
  }
  if (!w.ended_at && !w.deleted_at) queuedWorkoutIds.add(w.id)
  workouts.value = mergeWorkoutSummary(workouts.value, w).filter(live).sort((x, y) => (x.started_at < y.started_at ? 1 : -1))
}

function applySetRow(s: SetRow): void {
  const a = active.value
  if (!a || a.workout.id !== s.workout_id) return
  const sets = [...a.sets.filter((x) => x.id !== s.id), ...(s.deleted_at ? [] : [s])].sort(bySetOrder)
  const pr_ids = s.deleted_at ? a.pr_ids.filter((id) => id !== s.id) : a.pr_ids
  const exercise_ids = a.exercise_ids.includes(s.exercise_id) || s.deleted_at ? a.exercise_ids : [...a.exercise_ids, s.exercise_id]
  active.value = { ...a, sets, pr_ids, exercise_ids }
  persistActive()
  const stats = workoutStats(sets)
  workouts.value = workouts.value.map((w) => (w.id === s.workout_id ? { ...w, sets_count: stats.sets, volume: stats.volume, exercises_count: stats.exercises } : w))
}

function applyExerciseRow(e: Exercise): void {
  exercises.value = sortExercises(upsertById(exercises.value, e))
}

outbox.onEnqueue((table, row) => {
  if (table === 'workouts') applyWorkoutRow(row as unknown as Workout)
  else if (table === 'sets') applySetRow(row as unknown as SetRow)
  else if (table === 'exercises') applyExerciseRow(row as unknown as Exercise)
})

outbox.onFlushed((items) => {
  for (const it of items) if (it.table === 'workouts') queuedWorkoutIds.delete(String(it.row['id']))
})

// ---- rejected writes --------------------------------------------------------------------------------------

export interface Rejection { id: number; table: string; key: string; reason: string; label: string; at: string }
/** Lift rows the server refused (the outbox drops them for good); the workout screen shows each until dismissed. */
export const rejections = signal<Rejection[]>([])
let rejectionSeq = 0
export function dismissRejection(id: number): void {
  rejections.value = rejections.value.filter((r) => r.id !== id)
}

/**
 * A lift row the server rejected. A set of the running workout leaves the local mirror (the server will never have
 * it), so the set list, numbering and summary match what was saved, and the notice asks to log it again. main.tsx
 * already toasts every rejection for a few seconds; this keeps the lift ones in view on the workout screen.
 */
export function onWriteRejected(table: string, key: string, reason: string): void {
  if (table !== 'sets' && table !== 'workouts' && table !== 'exercises') return
  const a = active.value
  let label: string
  if (table === 'sets') {
    const s = a?.sets.find((x) => x.id === key)
    if (s) {
      const name = exercises.value.find((e) => e.id === s.exercise_id)?.name ?? 'this exercise'
      label = `Set ${s.set_no} of ${name} (${fmtWeight(s.weight)}×${s.reps}) was not saved. Log it again.`
      applySetRow({ ...s, deleted_at: nowIso() }) // local only: nothing to enqueue, the server never had it
    } else label = 'A set was not saved on the server.'
  } else if (table === 'workouts') {
    label = a?.workout.id === key ? 'This workout was not saved on the server.' : 'A workout was not saved on the server.'
  } else label = 'An exercise was not saved on the server.'
  rejections.value = [...rejections.value.slice(-4), { id: ++rejectionSeq, table, key, reason, label, at: nowIso() }]
}
outbox.onReject(onWriteRejected)

// A Today payload fetched while our new workout was still queued does not know about it: put it back.
effect(() => {
  const p = today.value
  const a = active.value
  if (!p || !a || a.workout.ended_at || a.workout.deleted_at) return
  if (p.running.workout?.id === a.workout.id || !queuedWorkoutIds.has(a.workout.id)) return
  today.value = { ...p, running: { ...p.running, workout: a.workout } }
})
