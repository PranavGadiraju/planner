// M5 work: projects, sessions, time blocks; M8 Mac-derived session suggestions. Routes are registered by spreading this array into ROUTES in ../index.ts.
// Handlers live in ./work/*.ts; the pure parsing (HH:MM on a day, minutes vs start/end, week grouping) is in
// ./work/parse.ts and unit-tested.
import type { Route } from '../env'
import { projectLog, projects } from './work/projects'
import { addSession, sessions } from './work/sessions'
import { workWeek } from './work/week'
import { addTimeBlocks } from './work/blocks'
import { suggestions } from './work/suggestions'

export const workRoutes: readonly Route[] = [
  { method: 'GET', path: '/api/projects', roles: ['app'], handler: projects },
  { method: 'GET', path: '/api/projects/:id/log', roles: ['app'], handler: projectLog },
  { method: 'GET', path: '/api/sessions', roles: ['app'], handler: sessions },
  { method: 'POST', path: '/api/sessions', roles: ['app'], handler: addSession },
  { method: 'GET', path: '/api/work/week', roles: ['app'], handler: workWeek },
  { method: 'POST', path: '/api/time-blocks', roles: ['app'], handler: addTimeBlocks },
  { method: 'GET', path: '/api/work/suggestions', roles: ['app'], handler: suggestions }, // M8: Mac-derived "log this?" ranges
]
