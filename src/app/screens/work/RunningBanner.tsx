// The running-session banner at the top of the Work tab: a live clock recomputed from started_at every second and
// on visibilitychange (so it is right after the tab was hidden), an optional screen wake lock, and End.
import { useEffect, useState } from 'preact/hooks'
import { Sheet } from '../../components/Sheet'
import { hhmm } from '../../data/format'
import { tz } from '../../data/store'
import { clockLabel, elapsedSeconds, projectById, projectColor, type SessionRow } from '../../data/work'
import { StopIcon } from './icons'

const KEEP_ON_KEY = 'planner.work.keepOn'

function readKeepOn(): boolean {
  try { return localStorage.getItem(KEEP_ON_KEY) === '1' } catch { return false }
}
function writeKeepOn(on: boolean): void {
  try { localStorage.setItem(KEEP_ON_KEY, on ? '1' : '0') } catch { /* ignore */ }
}

/** Ticks once a second while mounted, and immediately when the page becomes visible again. */
export function useSecondTick(): Date {
  const [at, setAt] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setAt(new Date()), 1000)
    const onVis = () => { if (document.visibilityState === 'visible') setAt(new Date()) }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis) }
  }, [])
  return at
}

/** Hold a screen wake lock while `on` (re-acquired after the page was hidden, released on unmount). */
function useWakeLock(on: boolean): boolean {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  useEffect(() => {
    if (!on || !supported) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false
    const request = async () => {
      try {
        lock = await navigator.wakeLock.request('screen')
        if (cancelled) await lock.release()
      } catch { /* denied, low battery, or the page is hidden */ }
    }
    const onVis = () => { if (document.visibilityState === 'visible') void request() }
    void request()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVis)
      void lock?.release().catch(() => {})
    }
  }, [on, supported])
  return supported
}

export function RunningBanner({ session, onEnd }: { session: SessionRow; onEnd: () => void }) {
  const at = useSecondTick()
  const [keepOn, setKeepOn] = useState(readKeepOn)
  const canKeepOn = useWakeLock(keepOn)
  const secs = elapsedSeconds(session.started_at, at)
  const project = projectById(session.project_id)
  const toggle = () => { const v = !keepOn; setKeepOn(v); writeKeepOn(v) }
  return (
    <section class="card run-card" aria-label="Running session" style={`--c:${projectColor(project)}`}>
      <div class="run-head">
        <i class="pulse-dot" style={{ background: 'var(--c)' }} />
        <span class="run-name">{session.project_name}</span>
        <span class="badge badge-study">{project?.kind === 'study' ? 'studying' : 'running'}</span>
      </div>
      <div class="run-clock num" aria-label={`Elapsed ${clockLabel(secs)}`}>{clockLabel(secs)}</div>
      <div class="run-sub">
        <span class="num">since {hhmm(session.started_at, tz.value)}</span>
        {canKeepOn && (
          <button type="button" class="keep-on" role="switch" aria-checked={keepOn} onClick={toggle}>
            Keep screen on <span class="switch" aria-hidden="true" aria-checked={keepOn} />
          </button>
        )}
      </div>
      <div class="run-actions">
        <button type="button" class="btn btn-primary btn-big grow" onClick={onEnd}>
          <StopIcon size={20} /> End session
        </button>
      </div>
    </section>
  )
}

/** "End <running> first?" panel used when starting a second session: one note line, then end + start. */
export function SwitchSheet({ running, targetName, onConfirm, onClose }: {
  running: SessionRow
  targetName: string
  onConfirm: (note: string) => Promise<void>
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const at = useSecondTick()
  const submit = async (e: Event) => {
    e.preventDefault()
    setBusy(true)
    try { await onConfirm(note) } finally { setBusy(false) }
  }
  return (
    <Sheet title={`End ${running.project_name} first?`} sub={`Running ${clockLabel(elapsedSeconds(running.started_at, at))} · then ${targetName} starts`} onClose={onClose}>
      <form class="stack" onSubmit={submit}>
        <div class="field">
          <label for="switch-note">What got done on {running.project_name}?</label>
          <input id="switch-note" type="text" value={note} autofocus onInput={(e) => setNote((e.currentTarget as HTMLInputElement).value)} enterkeyhint="done" autocomplete="off" placeholder="One line is enough" />
        </div>
        <button type="submit" class="btn btn-primary btn-big btn-block" disabled={busy}>
          <StopIcon size={18} /> End &amp; start {targetName}
        </button>
        <button type="button" class="btn btn-ghost btn-block" onClick={onClose}>Keep {running.project_name} running</button>
      </form>
    </Sheet>
  )
}
