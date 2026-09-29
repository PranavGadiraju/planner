// Timezone helpers built on Intl so the Worker (UTC) and the app agree on what "today" is.
// Never use SQLite 'localtime' or Date.getHours() for anything that lands in the database.

const fmtCache = new Map<string, Intl.DateTimeFormat>()
function fmt(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    fmtCache.set(tz, f)
  }
  return f
}

export interface LocalParts { y: number; m: number; d: number; h: number; mi: number; s: number }

export function localParts(ts: Date | string | number, tz: string): LocalParts {
  const date = ts instanceof Date ? ts : new Date(ts)
  const parts = fmt(tz).formatToParts(date)
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? '0')
  const h = get('hour')
  return { y: get('year'), m: get('month'), d: get('day'), h: h === 24 ? 0 : h, mi: get('minute'), s: get('second') }
}

const pad = (n: number) => String(n).padStart(2, '0')

/** YYYY-MM-DD of the instant in tz. */
export function localDay(ts: Date | string | number, tz: string): string {
  const p = localParts(ts, tz)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

/** 'HH:MM' of the instant in tz. */
export function localHHMM(ts: Date | string | number, tz: string): string {
  const p = localParts(ts, tz)
  return `${pad(p.h)}:${pad(p.mi)}`
}

/** Offset (ms) such that instant + offset == wall clock in tz expressed as a UTC timestamp. */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = localParts(date, tz)
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s)
  return asUTC - Math.floor(date.getTime() / 1000) * 1000
}

/** UTC instant of a wall-clock time (YYYY-MM-DD + HH:MM[:SS]) in tz. Correct across DST changes. */
export function zonedToUTC(day: string, hhmm: string, tz: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const [h, mi, s] = (hhmm.split(':').map(Number).concat([0, 0]) as number[]).slice(0, 3) as [number, number, number]
  const guess = Date.UTC(y, m - 1, d, h, mi, s)
  let off = tzOffsetMs(new Date(guess), tz)
  let inst = guess - off
  const off2 = tzOffsetMs(new Date(inst), tz)
  if (off2 !== off) inst = guess - off2
  return new Date(inst)
}

/** Local midnight of day in tz, as a UTC instant. */
export function localMidnightUTC(day: string, tz: string): Date {
  return zonedToUTC(day, '00:00', tz)
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const t = Date.UTC(y, m - 1, d) + n * 86400000
  const dt = new Date(t)
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** [start, end) of a local day and its length in minutes (1380 / 1440 / 1500 around DST changes). */
export function dayWindow(day: string, tz: string): { start: Date; end: Date; minutes: number } {
  const start = localMidnightUTC(day, tz)
  const end = localMidnightUTC(addDays(day, 1), tz)
  return { start, end, minutes: Math.round((end.getTime() - start.getTime()) / 60000) }
}

/** Monday-based week start for a local day. */
export function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 = Sunday
  const back = (dow + 6) % 7
  return addDays(day, -back)
}

export function isoNow(): string {
  return new Date().toISOString()
}

export function minutesBetween(a: Date | string, b: Date | string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 60000
}
