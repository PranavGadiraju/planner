// Week view: seven stacked columns (Mon-Sun), the per-category totals with averages and deltas vs last week
// ("so far" on the current week), the bedtime dots against the target line, routine completion squares, the
// kcal average when food was logged, and study hours by project. Data: one /api/summary range covering this
// week and the previous one (14 days).
import type { ComponentChildren } from 'preact'
import { addDays, weekStart } from '@shared/tz'
import { blockColor, hm } from '../../data/daymath'
import { dayHash } from '../../data/day'
import { settings, syncState } from '../../data/store'
import {
  SUM_CATEGORIES, SUM_LABELS, WEEKDAY_SHORT, avgPerDay, bedtimeStats, byDay, deltas, fmtInt, fmtLate, fmtSeconds, hasData, isoWeek, kcalAverage,
  mergeMaps, pick, routineCompletion, secondsOf, soFar, sumDays, weekLabel, weekOf, type DaySummary, type SumCategory, type Sums, type SummaryProject,
} from '../../data/summary'
import { navigate } from '../../router'
import { DeltaBadge, PeriodBar, StaleRefresh, TokenBanner, useSummary } from './shared'

/** Bottom-to-top stacking order of a column: rest first, screens, hand-typed, Unknown on top. */
const STACK: SumCategory[] = ['sleep', 'routine', 'workout', 'study', 'mac', 'phone', 'other', 'unknown']
/** Categories where more time is not "better", so the delta tint flips. */
const WORSE_WHEN_UP = new Set<SumCategory>(['phone', 'unknown'])
const DAY_S = 86400

export function WeekView({ date, today, switcher }: { date: string; today: string; switcher: ComponentChildren }) {
  const week = weekOf(date)
  const prevWeek = weekOf(addDays(week.start, -7))
  const isCurrent = week.start === weekStart(today)
  const s = useSummary(prevWeek.start, week.end)
  const sync = syncState.value
  const rows = byDay(s.data?.days ?? [])
  const projects = s.data?.projects ?? []

  const go = (start: string) => navigate(dayHash(start === weekStart(today) ? today : start))
  const cur = sumDays(pick(rows, week.days))
  // Averages come from complete days only: a live today (a few hours in) would drag every "avg / day" down.
  const complete = sumDays(pick(rows, week.days).filter((d) => !d.live))
  const prev = sumDays(pick(rows, prevWeek.days))
  const sf = isCurrent ? soFar(rows, week.start, today) : null
  const cmpCur = sf ? sf.cur : cur
  const cmpPrev = sf ? sf.prev : prev
  const d = deltas(cmpCur, cmpPrev)
  const grace = settings.value.late_grace_min
  const bed = bedtimeStats(week.days, rows, grace)
  const routine = routineCompletion(week.days, rows)
  const food = kcalAverage(pick(rows, week.days))
  const study = mergeMaps(pick(rows, week.days), 'study_by_project')

  return (
    <>
      <PeriodBar
        title={isCurrent ? 'This week' : `Week ${isoWeek(week.start)}`}
        sub={`${weekLabel(week)}${isCurrent ? ` · week ${isoWeek(week.start)}` : ''}`}
        pill={isCurrent ? null : { label: 'This week', onClick: () => go(weekStart(today)) }}
        onPrev={() => go(addDays(week.start, -7))}
        onNext={() => go(addDays(week.start, 7))}
        nextDisabled={isCurrent}
        onRefresh={() => void s.reload()}
        refreshing={s.loading}
        switcher={switcher}
      />
      <main class="content fade day-content">
        <TokenBanner state={sync} />
        {!s.data && s.loading && <div class="banner banner-info">Loading the week…</div>}
        {!s.data && !s.loading && s.error && (
          <div class="banner banner-danger">
            <span class="grow"><strong>Can't reach the server.</strong> {s.error}</span>
            <button type="button" class="btn btn-sm" onClick={() => void s.reload()}>Retry</button>
          </div>
        )}
        {s.data && (
          <>
            <Columns days={week.days} rows={rows} today={today} onRefresh={s.reload} />
            <TotalsCard cur={cur} complete={complete} cmpCur={cmpCur} d={d} soFar={sf ? sf.through + 1 : null} />
            <BedtimeCard days={week.days} rows={rows} grace={grace} stats={bed} today={today} />
            <RoutineCard per={routine.per_day} done={routine.done} total={routine.total} today={today} />
            {food.avg !== null && <FoodCard avg={food.avg} days={food.days} target={settings.value.targets.kcal} />}
            {study.length > 0 && <StudyCard rows={study} projects={projects} />}
            {s.cached && <p class="small faint day-foot">Showing a cached copy; pull down or tap refresh when back online.</p>}
          </>
        )}
      </main>
    </>
  )
}

// ---- stacked columns ---------------------------------------------------------------------------------------

const VB_W = 343
const VB_H = 170
const PAD_T = 6
const COL_GAP = 8

function Columns({ days, rows, today, onRefresh }: { days: string[]; rows: Map<string, DaySummary>; today: string; onRefresh: () => Promise<void> }) {
  const colW = VB_W / days.length
  const barW = colW - COL_GAP
  const h = VB_H - PAD_T
  const hours = [6, 12, 18]
  return (
    <section class="card week-card" aria-label="Week columns">
      <div class="card-head">
        <span class="card-title">Where the time went</span>
        <span class="small faint num">{days.filter((x) => hasData(rows.get(x))).length} of {days.length} days</span>
      </div>
      <svg class="week-svg" viewBox={`0 0 ${VB_W} ${VB_H}`} role="img" aria-label="Stacked columns of tracked time per day">
        <defs>
          <pattern id="wk-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="var(--surface-2)" />
            <rect width="2.5" height="6" fill="color-mix(in srgb, var(--cat-unknown) 55%, transparent)" />
          </pattern>
        </defs>
        {hours.map((hr) => (
          <line key={hr} x1="0" x2={VB_W} y1={PAD_T + h - (hr / 24) * h} y2={PAD_T + h - (hr / 24) * h} class="week-grid" />
        ))}
        {days.map((day, i) => {
          const r = rows.get(day)
          const x = i * colW + COL_GAP / 2
          if (!r || !hasData(r)) {
            const future = day > today
            return <rect key={day} x={x} y={PAD_T} width={barW} height={h} rx="5" class={future ? 'week-future' : 'week-empty'} />
          }
          const secs = secondsOf(r)
          let y = PAD_T + h
          const segs = STACK.map((k) => {
            const seg = (secs[k] / DAY_S) * h
            y -= seg
            return { k, y, seg }
          }).filter((sg) => sg.seg > 0)
          return (
            <g key={day}>
              {segs.map((sg) => (
                <rect
                  key={sg.k}
                  x={x}
                  y={sg.y}
                  width={barW}
                  height={Math.max(0.5, sg.seg)}
                  fill={sg.k === 'unknown' ? 'url(#wk-hatch)' : blockColor(sg.k, null)}
                />
              ))}
            </g>
          )
        })}
      </svg>
      <div class="week-labels">
        {days.map((day, i) => {
          const r = rows.get(day)
          return (
            <button key={day} type="button" class={`week-label${day === today ? ' is-today' : ''}${day > today ? ' is-future' : ''}`} onClick={() => navigate(dayHash(day))} disabled={day > today}>
              <span class="week-dow">{WEEKDAY_SHORT[i]}</span>
              <span class="week-dom num">{Number(day.slice(8))}</span>
              {r?.stale && <StaleRefresh day={day} onDone={onRefresh} />}
            </button>
          )
        })}
      </div>
      <div class="week-legend">
        {STACK.filter((k) => days.some((x) => { const r = rows.get(x); return !!r && secondsOf(r)[k] > 0 })).map((k) => (
          <span key={k} class="strip-key"><i class={`dot${k === 'unknown' ? ' hatched' : ''}`} style={`--c:${blockColor(k, null)}`} />{SUM_LABELS[k]}</span>
        ))}
      </div>
    </section>
  )
}

// ---- totals list ----------------------------------------------------------------------------------------------

function TotalsCard({ cur, complete, cmpCur, d, soFar }: { cur: Sums; complete: Sums; cmpCur: Sums; d: Record<SumCategory, number>; soFar: number | null }) {
  const show = SUM_CATEGORIES.filter((k) => cur.seconds[k] > 0 || d[k] !== 0)
  return (
    <section class="card" aria-label="Totals">
      <div class="card-head">
        <span class="card-title">Totals{soFar !== null ? ' · so far' : ''}</span>
        <span class="small faint">{soFar !== null ? `vs the same ${soFar} day${soFar === 1 ? '' : 's'} last week` : 'vs last week'}</span>
      </div>
      {show.length === 0 && <p class="small faint">Nothing tracked this week yet.</p>}
      <div class="totals-list">
        {show.map((k) => (
          <div key={k} class="totals-row">
            <i class={`dot${k === 'unknown' ? ' hatched' : ''}`} style={`--c:${blockColor(k, null)}`} />
            <div class="totals-main">
              <span class="totals-label">{SUM_LABELS[k]}</span>
              <span class="totals-avg small faint num">{complete.days_with_data ? `avg ${fmtSeconds(avgPerDay(complete, k))} / day` : 'no complete day yet'}</span>
            </div>
            <span class="totals-sum num">{fmtSeconds(soFar !== null ? cmpCur.seconds[k] : cur.seconds[k])}</span>
            <DeltaBadge seconds={d[k]} goodWhenUp={!WORSE_WHEN_UP.has(k)} />
          </div>
        ))}
      </div>
    </section>
  )
}

// ---- bedtime dots ---------------------------------------------------------------------------------------------

const BED_W = 343
const BED_H = 96
const BED_RANGE = 90 // minutes shown above/below the target line

function BedtimeCard({ days, rows, grace, stats, today }: { days: string[]; rows: Map<string, DaySummary>; grace: number; stats: ReturnType<typeof bedtimeStats>; today: string }) {
  const colW = BED_W / days.length
  const mid = BED_H / 2
  const yOf = (late: number) => mid + (Math.max(-BED_RANGE, Math.min(BED_RANGE, late)) / BED_RANGE) * (mid - 14)
  const graceY = yOf(grace)
  return (
    <section class="card" aria-label="Bedtime">
      <div class="card-head">
        <span class="card-title">Bedtime</span>
        <span class="small faint num">
          {stats.nights ? `${stats.on_target} of ${stats.nights} on target` : 'no nights logged'}
          {stats.avg_late !== null ? ` · avg ${fmtLate(stats.avg_late)} min` : ''}
        </span>
      </div>
      <svg class="bed-svg" viewBox={`0 0 ${BED_W} ${BED_H}`} role="img" aria-label="Bedtime minutes late per night against the target">
        <rect x="0" y={mid} width={BED_W} height={Math.max(0, graceY - mid)} class="bed-grace" />
        <line x1="0" x2={BED_W} y1={mid} y2={mid} class="bed-target" />
        <text x={BED_W - 2} y={mid - 4} class="bed-axis" text-anchor="end">target</text>
        {days.map((day, i) => {
          const late = rows.get(day)?.bed_late_min ?? null
          const cx = i * colW + colW / 2
          if (late === null) {
            return <circle key={day} cx={cx} cy={mid} r="4" class={day > today ? 'bed-dot-future' : 'bed-dot-none'} />
          }
          const cy = yOf(late)
          const tone = late <= grace ? 'ok' : late <= grace + 30 ? 'warn' : 'late'
          return (
            <g key={day}>
              <line x1={cx} x2={cx} y1={mid} y2={cy} class="bed-stem" />
              <circle cx={cx} cy={cy} r="5.5" class={`bed-dot bed-${tone}`} />
              <text x={cx} y={late > grace ? cy + 16 : cy - 9} class="bed-lbl num" text-anchor="middle">{fmtLate(late)}</text>
            </g>
          )
        })}
      </svg>
      <div class="week-labels week-labels-tight">
        {days.map((day, i) => <span key={day} class={`week-dow${day === today ? ' is-today' : ''}`}>{WEEKDAY_SHORT[i]}</span>)}
      </div>
      <p class="small faint bed-foot">
        {stats.streak > 0 ? `${stats.streak} night${stats.streak === 1 ? '' : 's'} in a row on target` : 'No streak yet'} · target = in bed by {settings.value.bed_target}, grace {grace} min
      </p>
    </section>
  )
}

// ---- routine squares ------------------------------------------------------------------------------------------

function RoutineCard({ per, done, total, today }: { per: { day: string; done: number; total: number }[]; done: number; total: number; today: string }) {
  return (
    <section class="card" aria-label="Routine">
      <div class="card-head">
        <span class="card-title">Routine</span>
        <span class="small faint num">{total ? `${done} of ${total} done` : 'no routine days yet'}</span>
      </div>
      <div class="routine-grid">
        {per.map((p, i) => (
          <div key={p.day} class={`routine-col${p.day === today ? ' is-today' : ''}${p.day > today ? ' is-future' : ''}`} aria-label={`${WEEKDAY_SHORT[i]} ${p.done} of ${p.total}`}>
            <div class="routine-squares">
              {Array.from({ length: Math.max(p.total, 0) }, (_, j) => <i key={j} class={`sq${j < p.done ? ' on' : ''}`} />)}
              {p.total === 0 && <i class="sq none" />}
            </div>
            <span class="week-dow">{WEEKDAY_SHORT[i]}</span>
            <span class="small faint num">{p.total ? `${p.done}/${p.total}` : '–'}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

// ---- food ------------------------------------------------------------------------------------------------------

export function FoodCard({ avg, days, target }: { avg: number; days: number; target: number }) {
  const share = target > 0 ? Math.min(1.25, avg / target) : 0
  return (
    <section class="card" aria-label="Food">
      <div class="card-head">
        <span class="card-title">Food</span>
        <span class="small faint num">{days} day{days === 1 ? '' : 's'} logged</span>
      </div>
      <div class="kcal-row">
        <span class="kcal-big num">{fmtInt(avg)} <span class="small faint">kcal avg</span></span>
        <span class="small faint num">target {fmtInt(target)}</span>
      </div>
      <div class="bar"><span class="bar-fill" style={`width:${(share * 80).toFixed(1)}%;--c:var(--cat-meal)`} /><span class="bar-mark" style="left:80%" /></div>
    </section>
  )
}

// ---- study by project --------------------------------------------------------------------------------------------

export function StudyCard({ rows, projects }: { rows: { key: string; seconds: number }[]; projects: SummaryProject[] }) {
  const max = rows[0]?.seconds ?? 1
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Untitled project'
  const color = (id: string) => projects.find((p) => p.id === id)?.color ?? 'var(--cat-study)'
  return (
    <section class="card" aria-label="Study">
      <div class="card-head">
        <span class="card-title">Study by project</span>
        <span class="small faint num">{hm(rows.reduce((a, r) => a + r.seconds, 0) / 60)}</span>
      </div>
      <div class="proj-list">
        {rows.map((r) => (
          <div key={r.key} class="proj-row">
            <span class="proj-name">{name(r.key)}</span>
            <span class="proj-hours num">{fmtSeconds(r.seconds)}</span>
            <div class="bar"><span class="bar-fill" style={`width:${((r.seconds / max) * 100).toFixed(1)}%;--c:${color(r.key)}`} /></div>
          </div>
        ))}
      </div>
    </section>
  )
}
