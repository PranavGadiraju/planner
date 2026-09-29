// Lift tab (route '#/lift[/...]'; sub-segments are in route.value.rest):
//   '#/lift'            home (templates + history)      '#/lift/start'       home with the start sheet open
//   '#/lift/w/<id>'     active workout                  '#/lift/s/<id>'      session detail
//   '#/lift/e/<id>'     exercise progress               '#/lift/exercises'   exercise library
import '../styles/lift.css'
import { route } from '../router'
import { LiftHome } from './lift/Home'
import { ActiveWorkout } from './lift/Active'
import { SessionDetail } from './lift/Session'
import { ExerciseProgress } from './lift/Progress'
import { ExerciseLibrary } from './lift/Library'

export function Lift() {
  const r = route.value
  const rest = r.name === 'lift' ? r.rest : []
  const head = rest[0]
  const id = rest[1]
  if (head === 'w' && id) return <ActiveWorkout id={id} />
  if (head === 's' && id) return <SessionDetail id={id} />
  if (head === 'e' && id) return <ExerciseProgress id={id} />
  if (head === 'exercises') return <ExerciseLibrary />
  return <LiftHome startSheet={head === 'start'} />
}
