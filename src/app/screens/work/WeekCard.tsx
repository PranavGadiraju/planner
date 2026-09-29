// Weekly mini bars: per project this week vs last week (so far), plus a 7-day column strip.
import { addDays } from '@shared/tz'
import { localToday } from '../../data/store'
import { elapsedDays, secondsLabel, weekBars, type WeekPayload } from '../../data/work'

const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

export function WeekCard({ week, loading }: { week: WeekPayload | null; loading: boolean }) {
  const today = localToday.value
  if (!week) {
    return (
      <section class="card" aria-label="This week">
        <div class="card-head"><span class="card-title">This week</span></div>
        <p class="small muted">{loading ? 'Loading the week…' : 'No week data yet.'}</p>
      </section>
    )
  }
  const bars = weekBars(week)
  const n = elapsedDays(week.week_start, today)
  const total = week.days.reduce((a, d) => a + d.seconds, 0)
  const lastSoFar = week.last_week.days.slice(0, Math.max(1, n)).reduce((a, d) => a + d.seconds, 0)
  const lastTotal = week.last_week.days.reduce((a, d) => a + d.seconds, 0)
  const max = Math.max(1, ...bars.map((b) => Math.max(b.this_week, b.last_week)))
  const dayMax = Math.max(1, ...week.days.map((d) => d.seconds), ...week.last_week.days.map((d) => d.seconds))
  const delta = total - lastSoFar
  return (
    <section class="card" aria-label="This week">
      <div class="card-head">
        <span class="card-title">This week</span>
        <span class="small faint num">
          {secondsLabel(total)}{lastTotal > 0 && <> · {delta >= 0 ? '+' : '−'}{secondsLabel(Math.abs(delta))} vs last week so far</>}
        </span>
      </div>
      {bars.length === 0 ? (
        <p class="small muted">Nothing logged this week or last. Start a session above.</p>
      ) : (
        <div>
          {bars.map((b) => (
            <div key={b.project_id} class="wk-row">
              <span class="wk-name"><i class="pdot" style={`--c:${b.color ?? 'var(--cat-study)'}`} /><span>{b.name}</span></span>
              <div class="wk-bars" role="img" aria-label={`${b.name}: ${secondsLabel(b.this_week)} this week, ${secondsLabel(b.last_week)} last week`}>
                <i class="wk-bar" style={`width:${((b.this_week / max) * 100).toFixed(1)}%;--c:${b.color ?? 'var(--cat-study)'}`} />
                <i class="wk-bar last" style={`width:${((b.last_week / max) * 100).toFixed(1)}%;--c:${b.color ?? 'var(--cat-study)'}`} />
              </div>
              <span class="wk-val num"><b>{secondsLabel(b.this_week)}</b>{b.last_week > 0 && <> / {secondsLabel(b.last_week)}</>}</span>
            </div>
          ))}
        </div>
      )}
      <div class="wk-days" role="img" aria-label={week.days.map((d, i) => `${DOW[i]} ${secondsLabel(d.seconds)}`).join(', ')}>
        {week.days.map((d, i) => (
          <span key={d.local_day} class={`wk-day${d.local_day === today ? ' today' : ''}${d.local_day > today ? ' future' : ''}`} title={`${d.local_day} · ${secondsLabel(d.seconds)}`}>
            <i style={`height:${Math.max(2, Math.round((d.seconds / dayMax) * 36))}px`} />
            <span>{DOW[i]}</span>
          </span>
        ))}
      </div>
      <div class="wk-legend"><span><i />this week</span><span><i class="last" />last week</span><span class="num" style={{ marginLeft: 'auto' }}>{week.week_start.slice(5)} – {addDays(week.week_start, 6).slice(5)}</span></div>
    </section>
  )
}
