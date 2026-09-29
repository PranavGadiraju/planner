// The running-workout line on Today (milestone 4 adds End / open-workout controls here).
import type { Workout } from '@shared/types'
import { durationLabel } from '../data/format'

export function RunningWorkout({ workout, at }: { workout: Workout; at: Date }) {
  const since = durationLabel((at.getTime() - new Date(workout.started_at).getTime()) / 60000)
  return (
    <span><span class="badge badge-workout">workout</span> {workout.name ?? 'Workout'} running · {since}</span>
  )
}
