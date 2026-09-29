// Hash router: '#/' today, '#/food', '#/lift', '#/work', '#/day', '#/settings', '#/settings/shortcut', ...
import { signal } from '@preact/signals'

export type Route =
  | { name: 'today' }
  | { name: 'food' }
  | { name: 'lift' }
  | { name: 'work' }
  | { name: 'day' }
  | { name: 'settings' }
  | { name: 'shortcut' }
  | { name: 'taps' }
  | { name: 'routine' }

export const TABS: { route: Route['name']; hash: string; label: string }[] = [
  { route: 'today', hash: '#/', label: 'Today' },
  { route: 'food', hash: '#/food', label: 'Food' },
  { route: 'lift', hash: '#/lift', label: 'Lift' },
  { route: 'work', hash: '#/work', label: 'Work' },
  { route: 'day', hash: '#/day', label: 'Day' },
]

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/\/+$/, '') || '/'
  switch (path) {
    case '/': return { name: 'today' }
    case '/food': return { name: 'food' }
    case '/lift': return { name: 'lift' }
    case '/work': return { name: 'work' }
    case '/day': return { name: 'day' }
    case '/settings': return { name: 'settings' }
    case '/settings/shortcut': return { name: 'shortcut' }
    case '/settings/taps': return { name: 'taps' }
    case '/settings/routine': return { name: 'routine' }
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
