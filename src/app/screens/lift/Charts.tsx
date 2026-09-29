// Inline SVG charts for one exercise: e1RM line with PR dots, and volume bars per session. Both share a
// time-based x scale; a tap selects the nearest session. No chart library.
import type { HistorySession } from '../../data/lift'

const W = 343
const H = 150
const PAD = { top: 14, right: 12, bottom: 22, left: 40 }

interface Scale { x: (iso: string) => number; y: (v: number) => number; ticks: number[] }

function niceStep(range: number, want: number): number {
  const raw = range / Math.max(1, want)
  const mag = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-9)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag
  return 10 * mag
}

function scale(sessions: readonly HistorySession[], values: (number | null)[], zeroBase: boolean): Scale {
  const t0 = new Date(sessions[0]?.started_at ?? 0).getTime()
  const t1 = new Date(sessions[sessions.length - 1]?.started_at ?? 0).getTime()
  const span = Math.max(1, t1 - t0)
  const nums = values.filter((v): v is number => v !== null)
  let lo = zeroBase ? 0 : Math.min(...nums)
  let hi = Math.max(...nums)
  if (!Number.isFinite(lo)) lo = 0
  if (!Number.isFinite(hi)) hi = 1
  if (hi === lo) { hi = lo + (lo === 0 ? 1 : Math.abs(lo) * 0.1) }
  const step = niceStep(hi - lo, 3)
  lo = zeroBase ? 0 : Math.floor(lo / step) * step
  hi = Math.ceil(hi / step) * step
  if (hi === lo) hi = lo + step
  const ticks: number[] = []
  for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(Number(v.toFixed(3)))
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom
  const single = sessions.length === 1
  return {
    x: (iso) => (single ? PAD.left + innerW / 2 : PAD.left + ((new Date(iso).getTime() - t0) / span) * innerW),
    y: (v) => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH,
    ticks,
  }
}

function dateTicks(sessions: readonly HistorySession[], sc: Scale): { x: number; label: string }[] {
  if (sessions.length === 0) return []
  const first = sessions[0]
  const last = sessions[sessions.length - 1]
  if (!first || !last) return []
  const fmt = (d: string) => { const [y, m, dd] = d.split('-'); return `${Number(dd)}/${Number(m)}${first.local_day.slice(0, 4) !== last.local_day.slice(0, 4) ? `/${(y ?? '').slice(2)}` : ''}` }
  if (sessions.length === 1) return [{ x: sc.x(first.started_at), label: fmt(first.local_day) }]
  const mid = sessions[Math.floor(sessions.length / 2)]
  const out = [{ x: sc.x(first.started_at), label: fmt(first.local_day) }, { x: sc.x(last.started_at), label: fmt(last.local_day) }]
  if (mid && mid !== first && mid !== last && sc.x(mid.started_at) - out[0]!.x > 60 && out[1]!.x - sc.x(mid.started_at) > 60) out.splice(1, 0, { x: sc.x(mid.started_at), label: fmt(mid.local_day) })
  return out
}

function nearest(sessions: readonly HistorySession[], sc: Scale, clientX: number, svg: SVGSVGElement): HistorySession | null {
  const rect = svg.getBoundingClientRect()
  const x = ((clientX - rect.left) / rect.width) * W
  let best: HistorySession | null = null
  let d = Infinity
  for (const s of sessions) {
    const dx = Math.abs(sc.x(s.started_at) - x)
    if (dx < d) { d = dx; best = s }
  }
  return best
}

function Axes({ sc, sessions, fmt }: { sc: Scale; sessions: readonly HistorySession[]; fmt: (v: number) => string }) {
  return (
    <>
      {sc.ticks.map((t) => (
        <g key={t}>
          <line class="grid" x1={PAD.left} x2={W - PAD.right} y1={sc.y(t)} y2={sc.y(t)} />
          <text class="axis" x={PAD.left - 6} y={sc.y(t) + 3.5} text-anchor="end">{fmt(t)}</text>
        </g>
      ))}
      {dateTicks(sessions, sc).map((t, i, arr) => (
        <text key={t.label + i} class="axis" x={t.x} y={H - 6} text-anchor={i === 0 ? 'start' : i === arr.length - 1 ? 'end' : 'middle'}>{t.label}</text>
      ))}
    </>
  )
}

const short = (v: number) => (v >= 10000 ? `${Math.round(v / 1000)}k` : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(Math.round(v)))

export function E1rmChart({ sessions, selected, onSelect }: { sessions: readonly HistorySession[]; selected: string | null; onSelect: (s: HistorySession) => void }) {
  const pts = sessions.filter((s) => s.best_e1rm !== null)
  if (pts.length === 0) return <div class="chart-empty">No working sets in this range.</div>
  const sc = scale(pts, pts.map((s) => s.best_e1rm), false)
  const path = pts.map((s, i) => `${i === 0 ? 'M' : 'L'}${sc.x(s.started_at).toFixed(1)},${sc.y(s.best_e1rm ?? 0).toFixed(1)}`).join(' ')
  const base = H - PAD.bottom
  const first = pts[0]
  const last = pts[pts.length - 1]
  const area = first && last ? `${path} L${sc.x(last.started_at).toFixed(1)},${base} L${sc.x(first.started_at).toFixed(1)},${base} Z` : ''
  const sel = pts.find((s) => s.workout_id === selected)
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Estimated one-rep max over time" onClick={(e) => { const s = nearest(pts, sc, e.clientX, e.currentTarget); if (s) onSelect(s) }}>
      <Axes sc={sc} sessions={pts} fmt={short} />
      {pts.length > 1 && <path class="area" d={area} />}
      {pts.length > 1 && <path class="line" d={path} />}
      {sel && <line class="sel-line" x1={sc.x(sel.started_at)} x2={sc.x(sel.started_at)} y1={PAD.top} y2={base} />}
      {pts.map((s) => (
        <circle key={s.workout_id} class={`pt${s.is_pr ? ' pr' : ''}${s.workout_id === selected ? ' sel' : ''}`} cx={sc.x(s.started_at)} cy={sc.y(s.best_e1rm ?? 0)} r={s.is_pr ? 5 : 3.5} />
      ))}
      {sel && sel.best_e1rm !== null && (
        <text class="lbl" x={Math.min(W - PAD.right - 4, Math.max(PAD.left + 4, sc.x(sel.started_at)))} y={Math.max(10, sc.y(sel.best_e1rm) - 10)} text-anchor="middle">{Math.round(sel.best_e1rm)}</text>
      )}
    </svg>
  )
}

export function VolumeChart({ sessions, selected, onSelect }: { sessions: readonly HistorySession[]; selected: string | null; onSelect: (s: HistorySession) => void }) {
  if (sessions.length === 0) return <div class="chart-empty">No sessions in this range.</div>
  const sc = scale(sessions, sessions.map((s) => s.volume), true)
  const base = H - PAD.bottom
  const innerW = W - PAD.left - PAD.right
  const bw = Math.max(3, Math.min(22, (innerW / Math.max(1, sessions.length)) * 0.6))
  const sel = sessions.find((s) => s.workout_id === selected)
  return (
    <svg class="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Volume per session" onClick={(e) => { const s = nearest(sessions, sc, e.clientX, e.currentTarget); if (s) onSelect(s) }}>
      <Axes sc={sc} sessions={sessions} fmt={short} />
      {sessions.map((s) => {
        const x = sc.x(s.started_at)
        const y = sc.y(s.volume)
        return <rect key={s.workout_id} class={`bar${s.workout_id === selected ? ' sel' : ''}`} x={x - bw / 2} y={y} width={bw} height={Math.max(0, base - y)} rx={2} />
      })}
      {sel && <text class="lbl" x={Math.min(W - PAD.right - 4, Math.max(PAD.left + 4, sc.x(sel.started_at)))} y={Math.max(10, sc.y(sel.volume) - 6)} text-anchor="middle">{short(sel.volume)}</text>}
    </svg>
  )
}
