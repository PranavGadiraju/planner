// The running-session line on Today (milestone 5 adds End / note controls here).
import type { Session } from '@shared/types'
import { durationLabel } from '../data/format'

export function RunningSession({ session, at }: { session: Session & { project_name: string }; at: Date }) {
  const since = durationLabel((at.getTime() - new Date(session.started_at).getTime()) / 60000)
  return (
    <span><span class="badge">session</span> {session.project_name} · {since}</span>
  )
}
