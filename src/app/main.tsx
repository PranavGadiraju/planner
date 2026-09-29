import { render } from 'preact'
import { registerSW } from 'virtual:pwa-register'
import './styles.css'
import { App } from './App'
import { toast } from './components/Toast'
import { startRouter } from './router'
import { loadToken } from './data/api'
import * as outbox from './data/outbox'
import { loadRoutineItemsCache, loadToday, startClock } from './data/store'

// Service worker: precached shell, registerType 'prompt', one "Reload for update" toast when a new build is waiting.
// Reload = push any queued writes first, then activate the waiting worker (which reloads the page).
// A home-screen app stays resident for days, so every return to the foreground also asks the browser to check
// for a new build (at most once a minute); without that the toast only appeared after a cold relaunch.
const UPDATE_CHECK_MIN_MS = 60_000
const updateSW = registerSW({
  onNeedRefresh() {
    toast('A new version is ready', {
      sticky: true,
      action: { label: 'Reload', fn: () => { void outbox.flush().catch(() => {}).then(() => updateSW(true)) } },
    })
  },
  onRegisteredSW(_url, r) {
    if (!r) return
    let lastCheck = Date.now()
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - lastCheck < UPDATE_CHECK_MIN_MS) return
      lastCheck = Date.now()
      void r.update().catch(() => {})
    })
  },
  onRegisterError(err) {
    console.warn('SW registration failed', err)
  },
})

// Ask once for durable storage (auto-granted for home-screen apps on iOS).
if (navigator.storage && typeof navigator.storage.persist === 'function') {
  void navigator.storage.persist().catch(() => {})
}

outbox.onReject((table, key, reason) => {
  toast(`Server rejected ${table} ${key}: ${reason}`, { kind: 'danger', duration: 6000 })
})

startRouter()
startClock()

const root = document.getElementById('app')
if (root) render(<App />, root)

void (async () => {
  await loadToken()
  await loadRoutineItemsCache()
  outbox.startOutbox()
  await loadToday()
})()
