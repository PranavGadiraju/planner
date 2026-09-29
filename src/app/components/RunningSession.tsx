// The running-session line on Today: elapsed time, End (opens the note sheet) and an Open link into the Work tab.
import { useState } from 'preact/hooks'
import type { Session } from '@shared/types'
import { durationLabel } from '../data/format'
import { EndSheet } from '../screens/work/EndSheet'

export function RunningSession({ session, at }: { session: Session & { project_name: string }; at: Date }) {
  const [ending, setEnding] = useState(false)
  const since = durationLabel((at.getTime() - new Date(session.started_at).getTime()) / 60000)
  return (
    <span class="run-inline">
      <span><span class="badge badge-study">session</span> {session.project_name} · {since}</span>
      <button type="button" class="btn btn-sm btn-primary" onClick={() => setEnding(true)}>End</button>
      <a class="btn btn-sm btn-ghost" href="#/work">Open</a>
      {ending && <EndSheet session={session} onClose={() => setEnding(false)} />}
    </span>
  )
}
