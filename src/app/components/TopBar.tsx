import type { ComponentChildren } from 'preact'
import { Icon } from './Icon'
import { back, navigate } from '../router'
import { fetchedAt, loading, syncState } from '../data/store'
import { pending } from '../data/outbox'
import { offline } from '../data/api'
import { agoLabel } from '../data/format'

export function SyncDot() {
  const state = syncState.value
  const n = pending.value
  const label =
    state === 'synced' ? 'Synced' :
    state === 'pending' ? `${n} pending` :
    state === 'offline' ? 'Offline' :
    state === 'unauthorized' ? 'Token rejected' : 'No token'
  return (
    <a class="sync" href="#/settings" data-state={state} aria-label={`Sync: ${label}`} title={label}>
      <span class="sync-dot" />
      {state === 'pending' && <span class="num">{n}</span>}
    </a>
  )
}

/** Main top bar for tab screens: title, optional subtitle, sync dot, refresh and gear. */
export function TopBar({ title, sub, onRefresh }: { title: string; sub?: string; onRefresh?: () => void }) {
  const cached = offline.value
  const subText = cached ? `offline · cached ${agoLabel(fetchedAt.value, new Date()).replace(' ago', '')}` : sub
  return (
    <header class="topbar">
      <div class="topbar-row">
        <div class="topbar-title">
          <h1>{title}</h1>
          {subText && <span class="topbar-sub">{subText}</span>}
        </div>
        <SyncDot />
        {onRefresh && (
          <button type="button" class="icon-btn" onClick={onRefresh} aria-label="Refresh" disabled={loading.value}>
            <Icon name="refresh" class={loading.value ? 'spin' : undefined} />
          </button>
        )}
        <button type="button" class="icon-btn" onClick={() => navigate('#/settings')} aria-label="Settings">
          <Icon name="gear" />
        </button>
      </div>
    </header>
  )
}

/** Top bar for sub-screens: back chevron + title (+ optional right slot). */
export function SubBar({ title, fallback = '#/', right }: { title: string; fallback?: string; right?: ComponentChildren }) {
  return (
    <header class="topbar">
      <div class="topbar-row">
        <button type="button" class="icon-btn" onClick={() => back(fallback)} aria-label="Back" style={{ marginLeft: '-8px' }}>
          <Icon name="back" />
        </button>
        <div class="topbar-title"><h1>{title}</h1></div>
        {right}
      </div>
    </header>
  )
}
