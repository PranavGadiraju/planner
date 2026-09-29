// Pure display helpers (no DOM, unit-tested).
import { localHHMM, localParts } from '@shared/tz'
import type { RoutineItem } from '@shared/types'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Mon 28 Sep" for a local day string. */
export function dayLabel(localDay: string): string {
  const [y, m, d] = localDay.split('-').map(Number) as [number, number, number]
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return `${WEEKDAYS[dow]} ${d} ${MONTHS[m - 1]}`
}

/** Local HH:MM of an ISO instant, or '' when the timestamp is missing. */
export function hhmm(ts: string | null | undefined, tz: string): string {
  return ts ? localHHMM(ts, tz) : ''
}

/** "7h32" / "41 min" style durations from minutes. */
export function durationLabel(min: number): string {
  const m = Math.max(0, Math.round(min))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return `${h}h${String(r).padStart(2, '0')}`
}

/** Short elapsed string for a running timer: "3m", "1h05". */
export function elapsedLabel(startIso: string, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - new Date(startIso).getTime()) / 60000))
  if (min < 60) return `${min}m`
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

/** "+20 min" / "-5 min" / "on time". */
export function lateLabel(lateMin: number): string {
  if (lateMin === 0) return 'on time'
  return `${lateMin > 0 ? '+' : '−'}${Math.abs(lateMin)} min`
}

/** Relative age: "just now", "12 min ago", "4 h ago", "2 d ago". */
export function agoLabel(ts: string | null | undefined, now: Date): string {
  if (!ts) return 'never'
  const sec = Math.max(0, (now.getTime() - new Date(ts).getTime()) / 1000)
  if (sec < 90) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 36) return `${h} h ago`
  return `${Math.round(h / 24)} d ago`
}

/** The label under a routine circle: the name when it is short, else the capitalised slug. */
export function shortName(item: Pick<RoutineItem, 'id' | 'name'>): string {
  const name = item.name.trim()
  if (name.length <= 9) return name
  const slug = item.id.replace(/[-_]+/g, ' ').trim()
  return slug.charAt(0).toUpperCase() + slug.slice(1)
}

/** Local hour (0-23) of an instant in tz. */
export function localHour(now: Date, tz: string): number {
  return localParts(now, tz).h
}

/** "HH:MM" minus n minutes, wrapping at midnight. */
export function minusMinutes(hhmmStr: string, minutes: number): string {
  const [h, m] = hhmmStr.split(':').map(Number) as [number, number]
  let total = ((h * 60 + m - minutes) % 1440 + 1440) % 1440
  const hh = Math.floor(total / 60)
  const mm = total % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** Deterministic UUID v4 from crypto; falls back to getRandomValues on older WebKit. */
export function uuid(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  const b = new Uint8Array(16)
  c.getRandomValues(b)
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
