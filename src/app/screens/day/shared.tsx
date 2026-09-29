// Pieces shared by the Day / Week / Month views: the segmented view switch (remembered in localStorage), the
// /api/summary range hook, the header shell, the stale-day refresh button and the small delta badge.
import type { ComponentChildren } from 'preact'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { Icon } from '../../components/Icon'
import { SyncDot } from '../../components/TopBar'
import { toast } from '../../components/Toast'
import { ApiError } from '../../data/api'
import { fmtDelta, loadRange, rollupDay, type SummaryResponse } from '../../data/summary'
import { navigate } from '../../router'

export type View = 'day' | 'week' | 'month'
const VIEW_KEY = 'planner.dayView'
export const VIEWS: { id: View; label: string }[] = [
  { id: 'day', label: 'Day' },
  { id: 'week', label: 'Week' },
  { id: 'month', label: 'Month' },
]

export function readView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY)
    return v === 'week' || v === 'month' ? v : 'day'
  } catch {
    return 'day'
  }
}
export function saveView(v: View): void {
  try { localStorage.setItem(VIEW_KEY, v) } catch { /* private mode */ }
}

export function ViewSwitch({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  return (
    <div class="seg view-seg" role="tablist" aria-label="View">
      {VIEWS.map((v) => (
        <button key={v.id} type="button" role="tab" aria-selected={view === v.id} aria-pressed={view === v.id} onClick={() => onChange(v.id)}>
          {v.label}
        </button>
      ))}
    </div>
  )
}

/** Header for the period views: prev / title + sub / [pill] / next / sync, then the view switch row. */
export function PeriodBar({ title, sub, pill, onPrev, onNext, nextDisabled, onRefresh, refreshing, switcher }: {
  title: string
  sub: string
  pill?: { label: string; onClick: () => void } | null
  onPrev: () => void
  onNext: () => void
  nextDisabled: boolean
  onRefresh: () => void
  refreshing: boolean
  switcher: ComponentChildren
}) {
  return (
    <header class="topbar">
      <div class="topbar-row">
        <button type="button" class="icon-btn" style={{ marginLeft: '-8px' }} onClick={onPrev} aria-label="Previous">
          <Icon name="back" />
        </button>
        <div class="topbar-title daybar-title">
          <h1>{title}</h1>
          <span class="topbar-sub">{sub}</span>
        </div>
        {pill && <button type="button" class="btn btn-sm today-pill" onClick={pill.onClick}>{pill.label}</button>}
        <button type="button" class="icon-btn" onClick={onNext} aria-label="Next" disabled={nextDisabled}>
          <Icon name="chevron" />
        </button>
        <button type="button" class="icon-btn" onClick={onRefresh} aria-label="Refresh" disabled={refreshing}>
          <Icon name="refresh" class={refreshing ? 'spin' : undefined} />
        </button>
        <SyncDot />
      </div>
      <div class="view-row">{switcher}</div>
    </header>
  )
}

export interface SummaryState {
  data: SummaryResponse | null
  loading: boolean
  error: string | null
  cached: boolean
}

/** Load one /api/summary range (network-first, cached per range); reloads when the range changes or the tab returns. */
export function useSummary(from: string, to: string): SummaryState & { reload: () => Promise<void> } {
  const [state, setState] = useState<SummaryState>({ data: null, loading: false, error: null, cached: false })
  const reload = useCallback(async () => {
    setState((s) => ({ ...s, loading: true }))
    try {
      const r = await loadRange(from, to)
      setState({ data: r.data, loading: false, error: null, cached: r.cached })
    } catch (err) {
      setState((s) => ({ ...s, loading: false, error: err instanceof ApiError ? err.message : 'Cannot reach the server' }))
    }
  }, [from, to])
  useEffect(() => {
    setState({ data: null, loading: false, error: null, cached: false })
    void reload()
    const onVisible = () => { if (document.visibilityState === 'visible') void reload() }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reload])
  return { ...state, reload }
}

/** The tiny refresh icon on a stale day: POST /api/rollup for it, then reload the range. */
export function StaleRefresh({ day, onDone, size = 12 }: { day: string; onDone: () => Promise<void>; size?: number }) {
  const [busy, setBusy] = useState(false)
  const run = async (e: Event) => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      await rollupDay(day)
      await onDone()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Rebuild failed', { kind: 'danger' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" class="stale-btn" onClick={(e) => void run(e)} aria-label={`Rebuild ${day}`} title="This day's totals are out of date. Tap to rebuild." disabled={busy}>
      <Icon name="refresh" size={size} stroke={2.4} class={busy ? 'spin' : undefined} />
    </button>
  )
}

/** "+1h 05m" in a small pill; sign decides the tint, `goodWhenUp` flips it for categories where more is worse. */
export function DeltaBadge({ seconds, goodWhenUp = true, suffix }: { seconds: number; goodWhenUp?: boolean; suffix?: string }) {
  const m = Math.round(seconds / 60)
  const tone = m === 0 ? 'flat' : (m > 0) === goodWhenUp ? 'up' : 'down'
  return (
    <span class="delta num" data-tone={tone}>
      {fmtDelta(seconds)}{suffix ? <span class="delta-suffix"> {suffix}</span> : null}
    </span>
  )
}

export function TokenBanner({ state }: { state: string }) {
  if (state !== 'no-token' && state !== 'unauthorized') return null
  return (
    <div class="banner banner-danger">
      <span class="grow"><strong>{state === 'no-token' ? 'No app token yet.' : 'The app token was rejected.'}</strong> Paste it in Settings to load the review.</span>
      <button type="button" class="btn btn-sm" onClick={() => navigate('#/settings')}>Settings</button>
    </div>
  )
}
