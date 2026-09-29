// '#/work/p/<id>': the per-project changelog. Notes over time with dates and durations, grouped by Mon-Sun week.
import { useEffect, useState } from 'preact/hooks'
import { SubBar } from '../../components/TopBar'
import { toast } from '../../components/Toast'
import { ApiError } from '../../data/api'
import { dayLabel, hhmm } from '../../data/format'
import { tz } from '../../data/store'
import {
  groupByWeek, loadProjectLog, loadProjects, projectById, projectColor, running, secondsLabel, type LogEntry, type ProjectLogPayload,
} from '../../data/work'
import { startFlow } from './StartSheet'
import { SwitchSheet } from './RunningBanner'
import { PlayIcon } from './icons'

export function ProjectLog({ id }: { id: string }) {
  const [state, setState] = useState<{ data: ProjectLogPayload | null; cached: boolean; error: string | null; loading: boolean }>({ data: null, cached: false, error: null, loading: true })
  const [switching, setSwitching] = useState(false)
  const load = async () => {
    setState((s) => ({ ...s, loading: true }))
    try {
      const r = await loadProjectLog(id)
      setState({ data: r?.data ?? null, cached: r?.cached ?? false, error: r ? null : 'No token yet', loading: false })
    } catch (err) {
      setState((s) => ({ ...s, error: err instanceof ApiError ? err.message : 'Cannot reach the server', loading: false }))
    }
  }
  useEffect(() => { void load(); if (!projectById(id)) void loadProjects() }, [id])

  const project = state.data?.project ?? projectById(id) ?? null
  const cur = running.value
  const start = async (note = '') => {
    if (!project) return
    toast(await startFlow(project, cur, note))
    setSwitching(false)
    void load()
  }
  const onStart = () => { if (cur && cur.project_id !== id) setSwitching(true); else void start() }
  const groups = state.data ? groupByWeek(state.data.entries) : []

  return (
    <>
      <SubBar
        title={project?.name ?? 'Project'}
        fallback="#/work"
        right={project && !project.archived_at ? (
          <button type="button" class={`btn btn-sm btn-start${cur?.project_id === id ? ' is-running' : ''}`} onClick={onStart} disabled={cur?.project_id === id}>
            <PlayIcon size={14} /> {cur?.project_id === id ? 'Running' : 'Start'}
          </button>
        ) : undefined}
      />
      <main class="content no-tabs fade">
        {state.error && !state.data && (
          <div class="banner banner-danger">
            <span class="grow"><strong>Could not load this project.</strong> {state.error}</span>
            <button type="button" class="btn btn-sm" onClick={() => void load()}>Retry</button>
          </div>
        )}
        {!state.data && state.loading && <div class="banner banner-info">Loading the changelog…</div>}
        {state.data && (
          <section class="card" aria-label="Totals" style={`--c:${projectColor(project)}`}>
            <div class="card-head">
              <span class="card-title" style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}><i class="pdot" style="background:var(--c)" /> {project?.kind === 'study' ? 'Study' : 'Project'}</span>
              {state.cached && <span class="badge badge-warn">cached</span>}
              {project?.archived_at && <span class="badge">archived</span>}
            </div>
            <div class="hero-stats">
              <div><b class="num">{secondsLabel(state.data.total_s)}</b><span>all time</span></div>
              <div><b class="num">{state.data.count}</b><span>sessions</span></div>
              <div><b class="num">{groups.length}</b><span>weeks</span></div>
            </div>
          </section>
        )}
        {state.data && groups.length === 0 && (
          <section class="card"><p class="empty-hint">No sessions yet. Start one and write what got done when you end it; it lands here.</p></section>
        )}
        {groups.map((g) => (
          <section key={g.week_start} class="card" aria-label={`Week of ${dayLabel(g.week_start)}`}>
            <div class="log-week-head">
              <span class="card-title" style={{ marginBottom: 0 }}>Week of {dayLabel(g.week_start)}</span>
              <span class="small faint num">{secondsLabel(g.seconds)} · {g.entries.length} session{g.entries.length === 1 ? '' : 's'}</span>
            </div>
            <div class="log-list">
              {g.entries.map((e) => <Entry key={e.id} e={e} />)}
            </div>
          </section>
        ))}
        {state.data && state.data.entries.length >= 200 && <p class="small faint" style={{ textAlign: 'center' }}>Showing the latest 200 sessions.</p>}
      </main>
      {switching && cur && project && <SwitchSheet running={cur} targetName={project.name} onConfirm={start} onClose={() => setSwitching(false)} />}
    </>
  )
}

function Entry({ e }: { e: LogEntry }) {
  const zone = tz.value
  const runningNow = !e.ended_at
  return (
    <div class="log-entry">
      <span class="log-day" title={e.local_day}>{dayLabel(e.local_day).replace(/ \w+$/, '')}</span>
      <span class={`log-note${e.note ? '' : ' empty'}`}>{e.note ?? (runningNow ? 'running…' : 'no note')}</span>
      <span class="log-dur num" title={`${hhmm(e.started_at, zone)}${e.ended_at ? `–${hhmm(e.ended_at, zone)}` : ''}${e.source === 'cli' ? ' · via Claude Code' : ''}`}>
        {e.duration_s !== null ? secondsLabel(e.duration_s) : hhmm(e.started_at, zone)}
      </span>
    </div>
  )
}
