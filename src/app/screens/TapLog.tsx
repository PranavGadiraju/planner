// The last 100 /api/tap calls with result badges.
import { useEffect, useState } from 'preact/hooks'
import { localDay } from '@shared/tz'
import { SubBar } from '../components/TopBar'
import { Icon } from '../components/Icon'
import { ApiError, apiGet } from '../data/api'
import { hhmm } from '../data/format'
import { now, tz } from '../data/store'

interface Tap { id: number; ts: string; item: string; role: string; result: string }

const OK = new Set(['routine_started', 'routine_finished', 'bed', 'wake', 'nap_then_bed', 'winddown'])
const WARN = new Set(['routine_duplicate', 'routine_ignored', 'routine_already_done', 'bed_duplicate', 'bed_ignored', 'bed_daytime_ignored', 'wake_duplicate'])

function badgeClass(result: string): string {
  if (OK.has(result)) return 'badge badge-ok'
  if (WARN.has(result)) return 'badge badge-warn'
  return 'badge badge-danger'
}

export function TapLog() {
  const [taps, setTaps] = useState<Tap[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [busy, setBusy] = useState(false)
  const zone = tz.value
  const today = localDay(now.value, zone)

  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await apiGet<{ taps: Tap[] }>('/api/tap/log', 'taplog')
      setTaps(r.data.taps ?? [])
      setCached(r.cached)
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Cannot reach the server')
    } finally { setBusy(false) }
  }
  useEffect(() => { void load() }, [])

  return (
    <>
      <SubBar
        title="NFC tap log"
        fallback="#/settings"
        right={<button type="button" class="icon-btn" onClick={() => void load()} aria-label="Refresh" disabled={busy}><Icon name="refresh" class={busy ? 'spin' : undefined} /></button>}
      />
      <main class="content no-tabs fade">
        {cached && <div class="banner banner-info small">Offline · showing the cached log.</div>}
        {error && <div class="banner banner-danger"><span class="grow">{error}</span><button type="button" class="btn btn-sm" onClick={() => void load()}>Retry</button></div>}
        {taps && taps.length === 0 && <div class="placeholder"><div class="glyph"><Icon name="tag" size={28} /></div><h2>No taps yet</h2><p>Every /api/tap call lands here, including duplicates and rejects.</p></div>}
        {taps && taps.length > 0 && (
          <section class="card" style={{ padding: '4px 8px' }}>
            <table class="table">
              <thead><tr><th>When</th><th>Item</th><th>Role</th><th>Result</th></tr></thead>
              <tbody>
                {taps.map((t) => {
                  const day = localDay(t.ts, zone)
                  return (
                    <tr key={t.id}>
                      <td class="num">{day === today ? hhmm(t.ts, zone) : <>{day.slice(5)} <span class="faint">{hhmm(t.ts, zone)}</span></>}</td>
                      <td class="mono">{t.item}</td>
                      <td class="faint">{t.role}</td>
                      <td><span class={badgeClass(t.result)}>{t.result.replace(/_/g, ' ')}</span></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>
        )}
      </main>
    </>
  )
}
