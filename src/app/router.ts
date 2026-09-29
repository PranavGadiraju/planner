// Hash router. Top-level tabs own a prefix and read the remaining segments themselves:
//   '#/'                today            '#/day' | '#/day/YYYY-MM-DD'   the day view
//   '#/food[/...]'      food tab         '#/lift[/...]'                 lift tab
//   '#/work[/...]'      work tab         '#/settings[/shortcut|taps|routine]'
import { signal } from '@preact/signals'

export type Route =
  | { name: 'today' }
  | { name: 'food'; rest: string[] }
  | { name: 'lift'; rest: string[] }
  | { name: 'work'; rest: string[] }
  | { name: 'day'; date: string | null }
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

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0] ?? ''
  const [head, ...rest] = path.split('/').map(decodeURIComponent).filter(Boolean)
  switch (head) {
    case undefined: return { name: 'today' }
    case 'food': return { name: 'food', rest }
    case 'lift': return { name: 'lift', rest }
    case 'work': return { name: 'work', rest }
    case 'day':
      if (rest[0] === undefined) return { name: 'day', date: null }
      return /^\d{4}-\d{2}-\d{2}$/.test(rest[0]) ? { name: 'day', date: rest[0] } : { name: 'today' }
    case 'settings':
      if (rest[0] === 'shortcut') return { name: 'shortcut' }
      if (rest[0] === 'taps') return { name: 'taps' }
      if (rest[0] === 'routine') return { name: 'routine' }
      if (rest[0] === 'apps') return { name: 'apps' }
      return { name: 'settings' }
    default: return { name: 'today' }
  }
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
