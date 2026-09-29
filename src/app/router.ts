// Hash router. Top-level tabs own a prefix and read the remaining segments themselves:
//   '#/'                today
//   '#/day'             the Day tab in the view last picked in its segmented control (remembered on the device)
//   '#/day/YYYY-MM-DD'  that day's timeline, always
//   '#/day/week[/YYYY-MM-DD]' | '#/day/month[/YYYY-MM-DD]'   the week / month containing the date (default today)
//   '#/food[/...]'      food tab         '#/lift[/...]'                 lift tab
//   '#/work[/...]'      work tab         '#/settings[/shortcut|taps|routine|apps]'
import { signal } from '@preact/signals'

export type DayView = 'day' | 'week' | 'month'

export type Route =
  | { name: 'today' }
  | { name: 'food'; rest: string[] }
  | { name: 'lift'; rest: string[] }
  | { name: 'work'; rest: string[] }
  /** view null = the remembered one (bare '#/day'); date null = today. */
  | { name: 'day'; view: DayView | null; date: string | null }
  | { name: 'settings' }
  | { name: 'shortcut' }
  | { name: 'taps' }
  | { name: 'routine' }
  | { name: 'apps' }

export const TABS: { route: Route['name']; hash: string; label: string }[] = [
  { route: 'today', hash: '#/', label: 'Today' },
  { route: 'food', hash: '#/food', label: 'Food' },
  { route: 'lift', hash: '#/lift', label: 'Lift' },
  { route: 'work', hash: '#/work', label: 'Work' },
  { route: 'day', hash: '#/day', label: 'Day' },
]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0] ?? ''
  const [head, ...rest] = path.split('/').map(decodeURIComponent).filter(Boolean)
  switch (head) {
    case undefined: return { name: 'today' }
    case 'food': return { name: 'food', rest }
    case 'lift': return { name: 'lift', rest }
    case 'work': return { name: 'work', rest }
    case 'day': {
      const [a, b] = rest
      if (a === undefined) return { name: 'day', view: null, date: null }
      if (a === 'week' || a === 'month') {
        if (b === undefined) return { name: 'day', view: a, date: null }
        return DATE_RE.test(b) ? { name: 'day', view: a, date: b } : { name: 'today' }
      }
      return DATE_RE.test(a) ? { name: 'day', view: 'day', date: a } : { name: 'today' }
    }
    case 'settings':
      if (rest[0] === 'shortcut') return { name: 'shortcut' }
      if (rest[0] === 'taps') return { name: 'taps' }
      if (rest[0] === 'routine') return { name: 'routine' }
      if (rest[0] === 'apps') return { name: 'apps' }
      return { name: 'settings' }
    default: return { name: 'today' }
  }
}

/**
 * Hash for a Day-tab view. A timeline is always addressed by its date ('#/day/<date>', so a deep link never lands
 * on a remembered Week or Month); week and month omit the date when it is today ('#/day/week').
 */
export function dayViewHash(view: DayView, date: string, today: string): string {
  if (view === 'day') return `#/day/${date}`
  return date === today ? `#/day/${view}` : `#/day/${view}/${date}`
}

export const route = signal<Route>(parseHash(typeof location !== 'undefined' ? location.hash : ''))

export function navigate(hash: string): void {
  if (location.hash === hash) return
  location.hash = hash
}

export function back(fallback = '#/settings'): void {
  if (history.length > 1) history.back()
  else navigate(fallback)
}

let started = false
export function startRouter(): void {
  if (started) return
  started = true
  window.addEventListener('hashchange', () => {
    route.value = parseHash(location.hash)
    window.scrollTo({ top: 0 })
  })
}
