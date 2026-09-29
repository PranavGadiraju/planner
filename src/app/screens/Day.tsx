// Day tab: a Day | Week | Month switch (remembered in localStorage; the route stays '#/day[/YYYY-MM-DD]').
// Day: the 24-hour ribbon for one date. Header with prev/next and a Today pill, a category strip, then a
// 1 px = 1 minute timeline with tappable blocks (detail sheet; manual blocks can be edited or deleted) and hatched
// Unknown gaps (Fill sheet -> a time_blocks row through the outbox, patched in optimistically).
// Week and Month (M7) live in ./day/Week.tsx and ./day/Month.tsx and read /api/summary.
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import type { Block, Gap } from '@shared/day'
import { CATEGORY_LABELS } from '@shared/day'
import type { BlockCategory, TimeBlock } from '@shared/types'
import { addDays, localDay, localHHMM, zonedToUTC } from '@shared/tz'
import { Sheet } from '../components/Sheet'
import { Icon } from '../components/Icon'
import { SyncDot } from '../components/TopBar'
import { toast } from '../components/Toast'
import { navigate, route } from '../router'
import { dayLabel, hhmm, uuid } from '../data/format'
import { localToday, now, syncState } from '../data/store'
import { dayHash, dayState, loadDay, watchDay, type DayPayload } from '../data/day'
import { SHORT_LABELS, blockColor, gapNeighbours, hm, minuteOf, ringSummary, stripSegments, titleCase, toBlockCategory } from '../data/daymath'
import * as outbox from '../data/outbox'
import { ViewSwitch, readView, saveView, type View } from './day/shared'
import { WeekView } from './day/Week'
import { MonthView } from './day/Month'
import '../styles/summary.css'

const LABEL_MIN_PX = 28
const MORNING_MIN = 7 * 60
const FILL_CATEGORIES: BlockCategory[] = ['sleep', 'workout', 'study', 'routine', 'meal', 'chores', 'social', 'commute', 'rest', 'phone', 'other']

interface FillTarget { start: string; end: string; gap?: Gap; row?: TimeBlock }

export function Day() {
  const r = route.value
  const todayStr = localToday.value
  const date = r.name === 'day' && r.date ? r.date : todayStr
  const [view, setView] = useState<View>(readView)
  const change = (v: View) => { saveView(v); setView(v) }
  const switcher = <ViewSwitch view={view} onChange={change} />
  if (view === 'week') return <WeekView date={date} today={todayStr} switcher={switcher} />
  if (view === 'month') return <MonthView date={date} today={todayStr} switcher={switcher} onOpenDay={(d) => { change('day'); navigate(dayHash(d)) }} />
  return <DayView date={date} todayStr={todayStr} switcher={switcher} />
}

function DayView({ date, todayStr, switcher }: { date: string; todayStr: string; switcher: ComponentChildren }) {
  const state = dayState(date).value
  const data = state.data
  const isToday = date === todayStr
  const [selected, setSelected] = useState<Block | null>(null)
  const [fill, setFill] = useState<FillTarget | null>(null)
  const sync = syncState.value

  useEffect(() => { void loadDay(date); return watchDay(date) }, [date])
  useEffect(() => { setSelected(null); setFill(null) }, [date])

  const go = (d: string) => navigate(dayHash(d))
  const del = async (row: TimeBlock) => {
    const ts = new Date().toISOString()
    await outbox.enqueue('time_blocks', { ...row, updated_at: ts, deleted_at: ts } as unknown as Record<string, unknown>)
    toast(`${row.label ?? titleCase(row.category)} removed`)
    setSelected(null)
  }

  return (
    <>
      <header class="topbar">
        <div class="topbar-row">
          <button type="button" class="icon-btn" style={{ marginLeft: '-8px' }} onClick={() => go(addDays(date, -1))} aria-label="Previous day">
            <Icon name="back" />
          </button>
          <div class="topbar-title daybar-title">
            <h1>{isToday ? 'Today' : dayLabel(date)}</h1>
            <span class="topbar-sub">{isToday ? dayLabel(date) : relativeDay(date, todayStr)}</span>
          </div>
          {!isToday && <button type="button" class="btn btn-sm today-pill" onClick={() => go(todayStr)}>Today</button>}
          <button type="button" class="icon-btn" onClick={() => go(addDays(date, 1))} aria-label="Next day" disabled={date >= todayStr}>
            <Icon name="chevron" />
          </button>
          <SyncDot />
        </div>
        <div class="view-row">{switcher}</div>
      </header>
      <main class="content fade day-content">
        {(sync === 'no-token' || sync === 'unauthorized') && (
          <div class="banner banner-danger">
            <span class="grow"><strong>{sync === 'no-token' ? 'No app token yet.' : 'The app token was rejected.'}</strong> Paste it in Settings to load the day.</span>
            <button type="button" class="btn btn-sm" onClick={() => navigate('#/settings')}>Settings</button>
          </div>
        )}
        {!data && state.loading && <div class="banner banner-info">Loading {isToday ? 'today' : dayLabel(date)}…</div>}
        {!data && !state.loading && state.error && (
          <div class="banner banner-danger">
            <span class="grow"><strong>Can't reach the server.</strong> {state.error}</span>
            <button type="button" class="btn btn-sm" onClick={() => void loadDay(date)}>Retry</button>
          </div>
        )}
        {data && <StripCard data={data} />}
        {data && (
          <Timeline
            data={data}
            isToday={isToday}
            onBlock={setSelected}
            onGap={(g) => setFill({ start: g.start, end: g.end, gap: g })}
          />
        )}
        {data && <p class="small faint day-foot">{data.sleep_inferred ? 'Sleep? is a guess until the wake time is set on Today. ' : ''}Tap a block for details, a hatched gap to fill it in.</p>}
      </main>
      {selected && data && (
        <BlockSheet
          block={selected}
          data={data}
          onClose={() => setSelected(null)}
          onEdit={(row) => { setSelected(null); setFill({ start: row.start_ts, end: row.end_ts, row }) }}
          onDelete={(row) => void del(row)}
        />
      )}
      {fill && data && <FillSheet target={fill} data={data} onClose={() => setFill(null)} />}
    </>
  )
}

function relativeDay(date: string, today: string): string {
  if (date === addDays(today, -1)) return 'Yesterday'
  const [y, m, d] = date.split('-').map(Number) as [number, number, number]
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number]
  const days = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86400_000)
  return days > 0 ? `${days} days ago` : 'Upcoming'
}

// ---- strip ---------------------------------------------------------------------------------------

function StripCard({ data }: { data: DayPayload }) {
  const segs = stripSegments(data.totals)
  const { known, unknown } = ringSummary(data.totals)
  const started = data.totals.tracked_s > 0
  return (
    <section class="card strip-card" aria-label="Totals">
      <div class="card-head">
        <span class="card-title">Totals</span>
        <span class="small faint num">{started ? `${hm(known)} tracked · ${hm(unknown)} unknown` : 'not started'}</span>
      </div>
      <div class="strip" role="img" aria-label={segs.map((s) => `${SHORT_LABELS[s.category]} ${hm(s.minutes)}`).join(', ') || 'No minutes yet'}>
        {segs.map((s) => (
          <span key={s.category} class={`strip-seg${s.category === 'unknown' ? ' hatched' : ''}`} style={`width:${(s.share * 100).toFixed(2)}%;--c:${blockColor(s.category, null)}`} />
        ))}
      </div>
      <div class="strip-legend">
        {segs.map((s) => (
          <span key={s.category} class="strip-key">
            <i class={`dot${s.category === 'unknown' ? ' hatched' : ''}`} style={`--c:${blockColor(s.category, null)}`} />
            {SHORT_LABELS[s.category]} <b class="num">{hm(s.minutes)}</b>
          </span>
        ))}
        {!started && <span class="strip-key faint">The day has not started yet.</span>}
      </div>
    </section>
  )
}

// ---- timeline ------------------------------------------------------------------------------------

function Timeline({ data, isToday, onBlock, onGap }: { data: DayPayload; isToday: boolean; onBlock: (b: Block) => void; onGap: (g: Gap) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const scrolledFor = useRef<string | null>(null)
  const N = data.minutes
  const at = now.value
  const nowMin = isToday ? Math.max(0, Math.min(N, minuteOf(at, data.start))) : null
  const tz = data.tz

  // Scroll once per day so "now" (today) or 07:00 (past days) sits about a third of the way down.
  useEffect(() => {
    const el = ref.current
    if (!el || scrolledFor.current === data.day) return
    scrolledFor.current = data.day
    const target = nowMin ?? MORNING_MIN
    const top = el.getBoundingClientRect().top + window.scrollY + target - Math.round(window.innerHeight * 0.36)
    window.scrollTo({ top: Math.max(0, top) })
  }, [data.day])

  const gapOf = (b: Block): Gap => data.gaps.find((g) => g.start === b.start) ?? { start: b.start, end: b.end, minutes: b.minutes }

  return (
    <div class="timeline" ref={ref} style={`height:${N}px`}>
      {hourMarks(data).map(({ h, top }) => (
        <div key={h} class="tl-hour" style={`top:${top}px`}>
          {/* the now label takes the gutter when it sits on an hour line */}
          {(nowMin === null || Math.abs(top - nowMin) > 12) && <span class="tl-hour-label num">{String(h).padStart(2, '0')}</span>}
        </div>
      ))}
      {nowMin !== null && nowMin < N && <div class="tl-future" style={`top:${nowMin}px;height:${N - nowMin}px`} />}
      {data.blocks.map((b) => {
        const top = Math.max(0, minuteOf(b.start, data.start))
        const h = b.minutes
        const range = `${hhmm(b.start, tz)}–${hhmm(b.end, tz)}`
        if (b.category === 'unknown') {
          return (
            <button
              key={b.start}
              type="button"
              class="tl-gap"
              style={`top:${top}px;height:${h}px;--s:${Math.max(14, Math.min(28, h - 2))}px`}
              onClick={() => onGap(gapOf(b))}
              aria-label={`Unknown ${range}, ${hm(h)}. Fill in`}
            >
              {h >= LABEL_MIN_PX && <span class="tl-label">Unknown</span>}
              {h >= LABEL_MIN_PX && <span class="tl-dur num">{hm(h)}</span>}
              {h >= 20 && <span class="tl-plus" aria-hidden="true"><Icon name="plus" size={14} stroke={2.2} /></span>}
            </button>
          )
        }
        return (
          <button
            key={b.start}
            type="button"
            class={`tl-block${b.source === 'sleep?' ? ' inferred' : ''}`}
            data-cat={b.category}
            style={`top:${top}px;height:${h}px;--c:${blockColor(b.category, b.sub)}`}
            onClick={() => onBlock(b)}
            aria-label={`${b.label} ${range}, ${hm(h)}`}
            title={`${b.label} · ${range} · ${hm(h)}`}
          >
            {h >= LABEL_MIN_PX && (
              <span class="tl-label">
                <span class="tl-name">{b.label}</span>
                {b.category === 'mac' && b.sub && <em class="tl-sub">{b.sub}</em>}
              </span>
            )}
            {h >= LABEL_MIN_PX && <span class="tl-dur num">{hm(h)}</span>}
          </button>
        )
      })}
      {data.markers.map((m) => (
        <span key={m.ts} class="tl-marker" style={`top:${minuteOf(m.ts, data.start)}px`} title={`${m.label} · ${m.kcal} kcal · ${hhmm(m.ts, tz)}`}>
          <Icon name="food" size={10} stroke={2.4} />
        </span>
      ))}
      {nowMin !== null && (
        <div class="tl-now" style={`top:${nowMin}px`}>
          <span class="tl-now-label num">{localHHMM(at, tz)}</span>
        </div>
      )}
    </div>
  )
}

// ---- block detail ----------------------------------------------------------------------------------

const SOURCE_LABELS: Record<string, string> = {
  manual: 'typed by hand', sleep: 'bed and wake taps', 'sleep?': 'guessed from the bed tap', workout: 'workout', session: 'session',
  routine: 'routine tap', mac: 'Mac screen time', 'mac-hours': 'Mac hourly totals', phone: 'phone screen time',
}

/** The manual row behind a block (a block can be a clipped piece of its row). */
function rowFor(data: DayPayload, b: Block): TimeBlock | null {
  // buildDay floors/ceils block edges to whole minutes, so compare instants with a one-minute tolerance.
  const bs = new Date(b.start).getTime(), be = new Date(b.end).getTime(), tol = 60_000
  const rows = (data.time_blocks ?? []).filter((r) => !r.deleted_at && new Date(r.start_ts).getTime() <= bs + tol && new Date(r.end_ts).getTime() >= be - tol)
  return rows.sort((x, y) => (x.start_ts < y.start_ts ? 1 : -1))[0] ?? null
}

/** Hour gridlines placed by wall clock, so DST days (1380 / 1500 minutes) keep labels next to the right minutes. */
function hourMarks(data: DayPayload): { h: number; top: number }[] {
  const out: { h: number; top: number }[] = []
  const seen = new Set<number>()
  for (let h = 0; h < 24; h++) {
    const top = minuteOf(zonedToUTC(data.day, `${String(h).padStart(2, '0')}:00`, data.tz).toISOString(), data.start)
    if (top < 0 || top >= data.minutes || seen.has(top)) continue
    seen.add(top)
    out.push({ h, top })
  }
  return out
}

function BlockSheet({ block, data, onClose, onEdit, onDelete }: {
  block: Block
  data: DayPayload
  onClose: () => void
  onEdit: (row: TimeBlock) => void
  onDelete: (row: TimeBlock) => void
}) {
  const tz = data.tz
  const manual = block.source === 'manual'
  const row = manual ? rowFor(data, block) : null
  const project = block.category === 'study' && block.sub ? data.projects.find((p) => p.id === block.sub) : null
  return (
    <Sheet title={block.label} sub={`${CATEGORY_LABELS[block.category]} · ${SOURCE_LABELS[block.source] ?? block.source}`} onClose={onClose}>
      <div class="stack">
        <div class="block-hero" style={`--c:${blockColor(block.category, block.sub)}`}>
          <span class="block-hero-time num">{hhmm(block.start, tz)} – {hhmm(block.end, tz)}</span>
          <span class="block-hero-dur num">{hm(block.minutes)}</span>
        </div>
        <dl class="kv">
          <dt>Category</dt><dd>{CATEGORY_LABELS[block.category]}{block.category === 'mac' && block.sub ? ` · ${block.sub}` : ''}</dd>
          {project && <><dt>Project</dt><dd>{project.name}</dd></>}
          <dt>Exact</dt><dd class="num small">{block.start.slice(11, 19)}Z – {block.end.slice(11, 19)}Z</dd>
        </dl>
        {block.source === 'sleep?' && (
          <div class="banner">
            <span class="grow small">The wake time is not confirmed, so this block guesses 8 h. Set it on Today.</span>
            <button type="button" class="btn btn-sm" onClick={() => navigate('#/')}>Today</button>
          </div>
        )}
        {manual && row && (
          <div class="grid-2">
            <button type="button" class="btn btn-big" onClick={() => onEdit(row)}><Icon name="edit" size={18} /> Edit</button>
            <button type="button" class="btn btn-big btn-danger" onClick={() => onDelete(row)}><Icon name="trash" size={18} /> Delete</button>
          </div>
        )}
        {manual && !row && <p class="small faint">This block can be edited once its row has synced. Pull to refresh in a moment.</p>}
      </div>
    </Sheet>
  )
}

// ---- fill / edit -----------------------------------------------------------------------------------

function FillSheet({ target, data, onClose }: { target: FillTarget; data: DayPayload; onClose: () => void }) {
  const tz = data.tz
  const editing = target.row ?? null
  const nb = target.gap ? gapNeighbours(data, target.gap) : { prev: null, next: null }
  const [cat, setCat] = useState<BlockCategory>(editing?.category ?? 'other')
  const [label, setLabel] = useState(editing?.label ?? '')
  const [start, setStart] = useState(localHHMM(target.start, tz))
  const [end, setEnd] = useState(localHHMM(target.end, tz))
  const [busy, setBusy] = useState(false)

  const copy = (b: Block) => {
    setCat(toBlockCategory(b.category))
    setLabel(b.label === titleCase(b.category) ? '' : b.label)
  }
  const save = async () => {
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) { toast('Set both times', { kind: 'danger' }); return }
    const baseDay = localDay(target.start, tz) // a block that began yesterday (23:30-00:30) keeps its own day
    const s = zonedToUTC(baseDay, start, tz)
    let e = zonedToUTC(baseDay, end, tz)
    if (e.getTime() <= s.getTime()) e = new Date(e.getTime() + 86400_000) // past midnight
    const ts = new Date().toISOString()
    const row: TimeBlock = {
      id: editing?.id ?? uuid(),
      start_ts: s.toISOString(), end_ts: e.toISOString(),
      category: cat, label: label.trim() || null, project_id: editing?.project_id ?? null,
      source: 'app', created_at: editing?.created_at ?? ts, updated_at: ts, deleted_at: null,
    }
    setBusy(true)
    try {
      await outbox.enqueue('time_blocks', row as unknown as Record<string, unknown>)
      toast(`${row.label ?? CATEGORY_LABELS[cat]} · ${start}–${end}`)
      onClose()
    } finally { setBusy(false) }
  }

  return (
    <Sheet
      title={editing ? 'Edit block' : 'Fill the gap'}
      sub={`${localHHMM(target.start, tz)} – ${localHHMM(target.end, tz)} · ${hm(minuteOf(target.end, target.start))}`}
      onClose={onClose}
    >
      <div class="stack">
        {(nb.prev || nb.next) && (
          <div class="row-wrap">
            {nb.prev && <button type="button" class="chip" onClick={() => copy(nb.prev as Block)}><Icon name="up" size={16} /> Same as {nb.prev.label}</button>}
            {nb.next && <button type="button" class="chip" onClick={() => copy(nb.next as Block)}><Icon name="down" size={16} /> Same as {nb.next.label}</button>}
          </div>
        )}
        <div class="field">
          <span class="label">Category</span>
          <div class="chips" role="group" aria-label="Category">
            {FILL_CATEGORIES.map((c) => (
              <button key={c} type="button" class="chip-cat" aria-pressed={cat === c} style={`--c:${blockColor(c, null)}`} onClick={() => setCat(c)}>
                <i class="dot" />{CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
        <div class="field">
          <label for="fill-label">Label <span class="faint">(optional)</span></label>
          <input id="fill-label" type="text" value={label} placeholder={CATEGORY_LABELS[cat]} onInput={(e) => setLabel((e.currentTarget as HTMLInputElement).value)} enterkeyhint="done" autocomplete="off" />
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="fill-start">From</label>
            <input id="fill-start" type="time" value={start} onInput={(e) => setStart((e.currentTarget as HTMLInputElement).value)} />
          </div>
          <div class="field">
            <label for="fill-end">To</label>
            <input id="fill-end" type="time" value={end} onInput={(e) => setEnd((e.currentTarget as HTMLInputElement).value)} />
          </div>
        </div>
        <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => void save()} disabled={busy}>
          <Icon name="check" size={20} /> {editing ? 'Save changes' : 'Save block'}
        </button>
      </div>
    </Sheet>
  )
}
