// M4 lift: exercises, workouts, sets. Routes are registered by spreading this array into ROUTES in ../index.ts.
// Handlers live in ./lift/*.ts; the pure helpers (history aggregation, body parsing) are in ./lift/logic.ts.
import type { Route } from '../env'
import { exerciseHistory, listExercises } from './lift/exercises'
import { lastSets, listWorkouts, template, workoutDetail } from './lift/workouts'
import { postSets } from './lift/sets'

export const liftRoutes: readonly Route[] = [
  { method: 'GET', path: '/api/exercises', roles: ['app'], handler: listExercises },
  { method: 'GET', path: '/api/exercises/:id/history', roles: ['app'], handler: exerciseHistory },
  { method: 'GET', path: '/api/workouts', roles: ['app'], handler: listWorkouts },
  { method: 'GET', path: '/api/workouts/:id', roles: ['app'], handler: workoutDetail },
  { method: 'GET', path: '/api/lift/template', roles: ['app'], handler: template },
  { method: 'GET', path: '/api/lift/last-sets', roles: ['app'], handler: lastSets },
  { method: 'POST', path: '/api/sets', roles: ['app'], handler: postSets },
]
