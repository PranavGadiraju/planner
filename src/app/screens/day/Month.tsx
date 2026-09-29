// Month view: category shares of tracked time (with the change vs the previous month), a calendar strip where
// every day shows its unknown share (so days without data stand out), study hours by project and the bedtime
// summary. Data: one /api/summary range covering this month and the previous one (at most 62 days).
import type { ComponentChildren } from 'preact'
import { weekStart } from '@shared/tz'
import { blockColor } from '../../data/daymath'
import { dayHash } from '../../data/day'
import { settings, syncState } from '../../data/store'
import {
  SUM_CATEGORIES, SUM_LABELS, WEEKDAY_SHORT, bedtimeStats, byDay, dayIndex, fmtLate, fmtPct, fmtPoints, hasData, kcalAverage, mergeMaps,
  monthLabel, monthOf, monthShort, pick, shareDeltas, shares, shiftMonth, sumDays, unknownShare, type DaySummary, type SumCategory,
} from '../../data/summary'
import { navigate } from '../../router'
import { PeriodBar, StaleRefresh, TokenBanner, useSummary } from './shared'
import { FoodCard, StudyCard } from './Week'

const WORSE_WHEN_UP = new Set<SumCategory>(['phone', 'unknown'])

export function MonthView({ date, today, switcher, onOpenDay }: { date: string; today: string; switcher: ComponentChildren; onOpenDay: (day: string) => void }) {
  const month = monthOf(date)
  const prevMonth = monthOf(shiftMonth(month.start, -1))
  const isCurrent = month.start === monthOf(today).start
  const s = useSummary(prevMonth.start, month.end)
  const sync = syncState.value
  const rows = byDay(s.data?.days ?? [])
  const projects = s.data?.projects ?? []

  const go = (firstOfMonth: string) => navigate(dayHash(firstOfMonth === monthOf(today).start ? today : firstOfMonth))
  const cur = sumDays(pick(rows, month.days))
  const prev = sumDays(pick(rows, prevMonth.days))
  const sh = shares(cur)
  const shPrev = shares(prev)
  const pp = shareDeltas(sh, shPrev)
  const grace = settings.value.late_grace_min
  const bed = bedtimeStats(month.days, rows, grace)
  const study = mergeMaps(pick(rows, month.days), 'study_by_project')
  const food = kcalAverage(pick(rows, month.days))

  return (
    <>
      <PeriodBar
        title={isCurrent ? 'This month' : monthLabel(month.start)}
        sub={isCurrent ? monthLabel(month.start) : `${month.days.length} days`}
        pill={isCurrent ? null : { label: 'This month', onClick: () => go(monthOf(today).start) }}
        onPrev={() => go(shiftMonth(month.start, -1))}
        onNext={() => go(shiftMonth(month.start, 1))}
        nextDisabled={isCurrent}
        onRefresh={() => void s.reload()}
        refreshing={s.loading}
        switcher={switcher}
      />
      <main class="content fade day-content">
        <TokenBanner state={sync} />
        {!s.data && s.loading && <div class="banner banner-info">Loading the month…</div>}
        {!s.data && !s.loading && s.error && (
          <div class="banner banner-danger">
            <span class="grow"><strong>Can't reach the server.</strong> {s.error}</span>
            <button type="button" class="btn btn-sm" onClick={() => void s.reload()}>Retry</button>
          </div>
        )}
        {s.data && (
          <>
            <SharesCard sh={sh} pp={pp} hasPrev={prev.days_with_data > 0} prevLabel={monthShort(prevMonth.start)} daysWithData={cur.days_with_data} days={month.days.filter((d) => d <= today).length} />
            <DayGrid days={month.days} rows={rows} today={today} onOpen={onOpenDay} onRefresh={s.reload} />
            {study.length > 0 && <StudyCard rows={study} projects={projects} />}
            <section class="card" aria-label="Bedtime">
              <div class="card-head">
                <span class="card-title">Bedtime</span>
                <span class="small faint num">{bed.nights ? `${bed.nights} night${bed.nights === 1 ? '' : 's'}` : 'no nights logged'}</span>
              </div>
              <div class="stat-row">
                <div class="stat"><span class="stat-big num">{bed.nights ? `${bed.on_target}/${bed.nights}` : '–'}</span><span class="small faint">on target</span></div>
                <div class="stat"><span class="stat-big num">{bed.avg_late !== null ? `${fmtLate(bed.avg_late)}` : '–'}</span><span class="small faint">avg min late</span></div>
                <div class="stat"><span class="stat-big num">{bed.streak}</span><span class="small faint">night streak</span></div>
              </div>
            </section>
            {food.avg !== null && <FoodCard avg={food.avg} days={food.days} target={settings.value.targets.kcal} />}
            {s.cached && <p class="small faint day-foot">Showing a cached copy; tap refresh when back online.</p>}
          </>
        )}
      </main>
    </>
  )
}

// ---- shares ----------------------------------------------------------------------------------------------------

function SharesCard({ sh, pp, hasPrev, prevLabel, daysWithData, days }: {
  sh: Record<SumCategory, number>; pp: Record<SumCategory, number>; hasPrev: boolean; prevLabel: string; daysWithData: number; days: number
}) {
  const show = SUM_CATEGORIES.filter((k) => sh[k] > 0)
  return (
    <section class="card" aria-label="Shares">
      <div class="card-head">
        <span class="card-title">Share of tracked time</span>
        <span class="small faint num">{daysWithData} of {days} days with data</span>
      </div>
      {show.length === 0 && <p class="small faint">No summaries for this month yet.</p>}
      {show.length > 0 && (
        <div class="strip" role="img" aria-label={show.map((k) => `${SUM_LABELS[k]} ${fmtPct(sh[k])}`).join(', ')}>
          {show.map((k) => <span key={k} class={`strip-seg${k === 'unknown' ? ' hatched' : ''}`} style={`width:${(sh[k] * 100).toFixed(2)}%;--c:${blockColor(k, null)}`} />)}
        </div>
      )}
      <div class="shares-list">
        {show.map((k) => {
          const m = Math.round(pp[k] * 10) / 10
          const tone = !hasPrev || m === 0 ? 'flat' : (m > 0) === !WORSE_WHEN_UP.has(k) ? 'up' : 'down'
          return (
            <div key={k} class="shares-row">
              <i class={`dot${k === 'unknown' ? ' hatched' : ''}`} style={`--c:${blockColor(k, null)}`} />
              <span class="totals-label grow">{SUM_LABELS[k]}</span>
              <span class="shares-pct num">{fmtPct(sh[k])}</span>
              <span class="delta num" data-tone={tone} title={hasPrev ? `vs ${prevLabel}` : 'no previous month'}>
                {hasPrev ? fmtPoints(pp[k]) : '–'}<span class="delta-suffix"> pp</span>
              </span>
            </div>
          )
        })}
      </div>
      {hasPrev && <p class="small faint shares-foot">Change in percentage points vs {prevLabel}.</p>}
    </section>
  )
}

// ---- day grid ------------------------------------------------------------------------------------------------------

function DayGrid({ days, rows, today, onOpen, onRefresh }: { days: string[]; rows: Map<string, DaySummary>; today: string; onOpen: (d: string) => void; onRefresh: () => Promise<void> }) {
  const first = days[0] as string
  const lead = dayIndex(weekStart(first), first) // blank cells before the 1st
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...days]
  while (cells.length % 7) cells.push(null)
  return (
    <section class="card" aria-label="Days">
      <div class="card-head">
        <span class="card-title">Unknown share per day</span>
        <span class="small faint">tap a day to open it</span>
      </div>
      <div class="month-grid">
        {WEEKDAY_SHORT.map((w) => <span key={w} class="month-dow">{w.slice(0, 1)}</span>)}
        {cells.map((day, i) => {
          if (!day) return <span key={`b${i}`} class="month-cell blank" />
          const r = rows.get(day)
          const future = day > today
          const data = hasData(r)
          const unk = unknownShare(r)
          const cls = `month-cell${future ? ' future' : ''}${!future && !data ? ' nodata' : ''}${day === today ? ' is-today' : ''}`
          return (
            <button key={day} type="button" class={cls} onClick={() => onOpen(day)} disabled={future} aria-label={`${day}: ${future ? 'upcoming' : data ? `${fmtPct(1 - unk)} tracked` : 'no data'}`}>
              <span class="month-num num">{Number(day.slice(8))}</span>
              {!future && (
                <span class="month-bar">
                  <span class="month-fill" style={`height:${((1 - unk) * 100).toFixed(0)}%`} />
                </span>
              )}
              {r?.stale && <StaleRefresh day={day} onDone={onRefresh} size={11} />}
            </button>
          )
        })}
      </div>
      <div class="week-legend">
        <span class="strip-key"><i class="dot" style="--c:var(--accent)" />tracked</span>
        <span class="strip-key"><i class="dot hatched" />unknown / no data</span>
        <span class="strip-key"><i class="dot" style="--c:var(--surface-3)" />upcoming</span>
      </div>
      {days.some((d) => rows.get(d)?.stale) && <p class="small faint shares-foot">Days with a refresh icon have totals that are out of date; tap it to rebuild.</p>}
    </section>
  )
}
