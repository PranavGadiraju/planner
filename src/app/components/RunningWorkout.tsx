// The running-workout line on Today: name + elapsed, Open (the active workout screen) and End (finishes it now).
import type { Workout } from '@shared/types'
import { durationLabel } from '../data/format'
import { finishWorkout, loadWorkouts } from '../data/lift'
import { toast } from './Toast'

export function RunningWorkout({ workout, at }: { workout: Workout; at: Date }) {
  const since = durationLabel((at.getTime() - new Date(workout.started_at).getTime()) / 60000)
  const end = async () => {
    try {
      const r = await finishWorkout(workout)
      toast(r.line, { duration: 5000 })
      void loadWorkouts()
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not end the workout', { kind: 'danger' })
    }
  }
  return (
    <span class="row row-wrap" style={{ gap: '6px 10px' }}>
      <span class="grow"><span class="badge badge-workout">workout</span> {workout.name ?? 'Workout'} running · {since}</span>
      <a class="btn btn-sm" href={`#/lift/w/${workout.id}`}>Open</a>
      <button type="button" class="btn btn-sm btn-primary" onClick={() => void end()}>End</button>
    </span>
  )
}
