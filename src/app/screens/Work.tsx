// Work tab ('#/work[/...]'): running banner, project rows with Start, "+ Manual", Mac-derived session suggestions,
// today's sessions with notes, weekly bars, and the project sheet. '#/work/start' opens the picker at once (Today's quick action),
// '#/work/manual' the manual sheet, '#/work/p/<id>' a project's changelog.
import { useEffect, useState } from 'preact/hooks'
import type { Project } from '@shared/types'
import '../styles/work.css'
import { TopBar } from '../components/TopBar'
import { Icon } from '../components/Icon'
import { toast } from '../components/Toast'
import { navigate, route } from '../router'
import { hhmm } from '../data/format'
import { localToday, syncState, tz } from '../data/store'
import {
  activeProjects, loadWork, projectById, projectColor, projectHash, running, secondsLabel, todaySeconds, todaySessions, week, workError, workLoading,
  workSource, type SessionRow,
} from '../data/work'
import { RunningBanner, SwitchSheet, useSecondTick } from './work/RunningBanner'
import { EndSheet } from './work/EndSheet'
import { StartSheet, startFlow } from './work/StartSheet'
import { ManualSheet } from './work/ManualSheet'
import { ProjectsSheet } from './work/ProjectsSheet'
import { WeekCard } from './work/WeekCard'
import { SuggestedCard } from './work/SuggestedCard'
import { ProjectLog } from './work/ProjectLog'
import { PlayIcon } from './work/icons'

type SheetState = null | { kind: 'end' } | { kind: 'start' } | { kind: 'manual' } | { kind: 'projects' } | { kind: 'edit'; session: SessionRow } | { kind: 'switch'; target: Project }

export function Work() {
  const r = route.value
  const rest = r.name === 'work' ? r.rest : []
  if (rest[0] === 'p' && rest[1]) return <ProjectLog id={rest[1]} />
  return <WorkHome action={rest[0] ?? null} />
}

function WorkHome({ action }: { action: string | null }) {
  const day = localToday.value
  const [sheet, setSheet] = useState<SheetState>(null)
  useEffect(() => { void loadWork() }, [day])
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') void loadWork() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])
  // Deep links from Today's quick action; the hash is replaced so Back does not reopen the sheet.
  useEffect(() => {
    if (action === 'start') setSheet({ kind: 'start' })
    else if (action === 'manual') setSheet({ kind: 'manual' })
  }, [action])
  const close = () => {
    setSheet(null)
    if (route.value.name === 'work' && route.value.rest.length) location.replace('#/work')
  }

  const run = running.value
  const list = todaySessions.value
  const secs = todaySeconds.value
  const sync = syncState.value
  const sub = secs > 0 ? `${secondsLabel(secs)} today` : run ? 'running' : undefined

  const start = async (p: Project) => {
    if (run) { setSheet({ kind: 'switch', target: p }); return }
    toast(await startFlow(p, null))
  }

  return (
    <>
      <TopBar title="Work" sub={workSource.value === 'cached' ? undefined : sub} onRefresh={() => void loadWork()} />
      <main class="content fade">
        {(sync === 'no-token' || sync === 'unauthorized') && (
          <div class="banner banner-danger">
            <span class="grow"><strong>{sync === 'no-token' ? 'No app token yet.' : 'The app token was rejected.'}</strong> Paste it in Settings to load and sync.</span>
            <button type="button" class="btn btn-sm" onClick={() => navigate('#/settings')}>Settings</button>
          </div>
        )}
        {workError.value && !workLoading.value && (
          <div class="banner">
            <span class="grow small"><strong>Can't reach the server.</strong> {workError.value}{workSource.value === 'cached' ? ' · showing the cached copy' : ''}</span>
            <button type="button" class="btn btn-sm" onClick={() => void loadWork()}>Retry</button>
          </div>
        )}
        {run && <RunningBanner session={run} onEnd={() => setSheet({ kind: 'end' })} />}
        <ProjectsCard running={run} onStart={(p) => void start(p)} onManual={() => setSheet({ kind: 'manual' })} onManage={() => setSheet({ kind: 'projects' })} />
        <SuggestedCard />
        <TodayCard sessions={list} onEdit={(s) => setSheet({ kind: 'edit', session: s })} />
        <WeekCard week={week.value} loading={workLoading.value} />
      </main>
      {sheet?.kind === 'end' && run && <EndSheet session={run} onClose={close} />}
      {sheet?.kind === 'start' && <StartSheet onClose={close} />}
      {sheet?.kind === 'manual' && <ManualSheet onClose={close} />}
      {sheet?.kind === 'edit' && <ManualSheet editing={sheet.session} onClose={close} />}
      {sheet?.kind === 'projects' && <ProjectsSheet onClose={close} />}
      {sheet?.kind === 'switch' && run && (
        <SwitchSheet
          running={run}
          targetName={sheet.target.name}
          onConfirm={async (note) => { toast(await startFlow(sheet.target, run, note)); close() }}
          onClose={close}
        />
      )}
    </>
  )
}

function ProjectsCard({ running: run, onStart, onManual, onManage }: { running: SessionRow | null; onStart: (p: Project) => void; onManual: () => void; onManage: () => void }) {
  const list = activeProjects.value
  const w = week.value
  const weekSecs = (id: string) => (w ? w.days.reduce((a, d) => a + (d.by_project[id] ?? 0), 0) : 0)
  return (
    <section class="card" aria-label="Projects">
      <div class="card-head">
        <span class="card-title">Projects</span>
        <div class="card-actions">
          <button type="button" class="btn btn-sm btn-ghost" onClick={onManual}><Icon name="plus" size={16} /> Manual</button>
          <button type="button" class="icon-btn" onClick={onManage} aria-label="Manage projects"><Icon name="edit" size={20} /></button>
        </div>
      </div>
      {list.length === 0 ? (
        <div class="stack-sm">
          <p class="empty-hint">No projects yet. Add a side project or a course, then Start to time a session.</p>
          <button type="button" class="btn btn-primary btn-block" onClick={onManage}><Icon name="plus" size={18} /> Add a project</button>
        </div>
      ) : (
        <div class="proj-list">
          {list.map((p) => {
            const isRunning = run?.project_id === p.id
            const s = weekSecs(p.id)
            return (
              <div key={p.id} class="proj-row">
                <a class="proj-main list-link" href={projectHash(p.id)} aria-label={`${p.name}: open changelog`}>
                  <span class="proj-name"><i class="pdot" style={`--c:${projectColor(p)}`} /><span>{p.name}</span>{p.kind === 'study' && <span class="badge badge-study">study</span>}</span>
                  <span class="proj-meta">{s > 0 ? `${secondsLabel(s)} this week` : 'nothing this week'}{isRunning ? ' · running' : ''}</span>
                </a>
                <button type="button" class={`btn btn-start${isRunning ? ' is-running' : ''}`} onClick={() => onStart(p)} disabled={isRunning} aria-label={isRunning ? `${p.name} is running` : `Start ${p.name}`}>
                  <PlayIcon size={16} /> {isRunning ? 'Running' : 'Start'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function TodayCard({ sessions, onEdit }: { sessions: SessionRow[]; onEdit: (s: SessionRow) => void }) {
  const zone = tz.value
  const at = useSecondTick()
  const done = sessions.filter((s) => s.ended_at)
  const total = done.reduce((a, s) => a + (s.duration_s ?? 0), 0)
  return (
    <section class="card" aria-label="Today's sessions">
      <div class="card-head">
        <span class="card-title">Today</span>
        <span class="small faint num">{done.length === 0 ? 'no sessions yet' : `${secondsLabel(total)} · ${done.length} session${done.length === 1 ? '' : 's'}`}</span>
      </div>
      {sessions.length === 0 ? (
        <p class="empty-hint">Nothing logged today. Start a session, or add one by hand with + Manual.</p>
      ) : (
        <div class="sess-list">
          {sessions.map((s) => {
            const live = !s.ended_at
            const secs = live ? Math.max(0, Math.floor((at.getTime() - new Date(s.started_at).getTime()) / 1000)) : s.duration_s ?? 0
            return (
              <button key={s.id} type="button" class="sess-row" onClick={() => (live ? undefined : onEdit(s))} disabled={live} aria-label={`${s.project_name} ${hhmm(s.started_at, zone)}${s.ended_at ? `–${hhmm(s.ended_at, zone)}` : ' running'}, ${secondsLabel(secs)}${live ? '' : '. Edit'}`}>
                <span class="sess-time num">{hhmm(s.started_at, zone)}–{s.ended_at ? hhmm(s.ended_at, zone) : 'now'}</span>
                <span class="sess-body">
                  <span class="sess-title">
                    <i class="pdot" style={`--c:${projectColor(sessionProject(s))}`} />
                    <span class="pname">{s.project_name}</span>
                    {s.source === 'cli' && <span class="badge" title="Logged from Claude Code">cli</span>}
                    <span class="dur">{secondsLabel(secs)}</span>
                  </span>
                  <span class={`sess-note${s.note ? '' : ' empty'}`}>{s.note ?? (live ? 'running…' : 'no note')}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function sessionProject(s: SessionRow): { color: string | null } | undefined {
  return projectById(s.project_id)
}
