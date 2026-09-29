// One 56 px routine circle: outline (not started) / progress ring with elapsed minutes (running) / filled with the finish time (done).
// Tap = start or finish now; long-press (500 ms) opens the edit sheet.
import { useRef } from 'preact/hooks'
import type { RoutineItem, RoutineLog } from '@shared/types'
import { Icon, routineIconName } from './Icon'
import { routineIsDone } from '@shared/routine'
import { elapsedLabel, hhmm, shortName } from '../data/format'

const R = 26
const CIRC = 2 * Math.PI * R
const LONG_PRESS_MS = 500

export type CircleState = 'idle' | 'running' | 'done'

export function circleState(log: RoutineLog | undefined, now: Date = new Date()): CircleState {
  if (!log || log.deleted_at) return 'idle'
  return routineIsDone(log, now) ? 'done' : 'running'
}

export function RoutineCircle({ item, log, tz, now, onTap, onLongPress }: {
  item: RoutineItem
  log: RoutineLog | undefined
  tz: string
  now: Date
  onTap: () => void
  onLongPress: () => void
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const state = circleState(log, now)

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  const down = () => {
    fired.current = false
    clear()
    timer.current = setTimeout(() => { fired.current = true; timer.current = null; onLongPress() }, LONG_PRESS_MS)
  }
  const click = () => {
    clear()
    if (fired.current) { fired.current = false; return }
    onTap()
  }

  let progress = 0
  if (state === 'running' && log) {
    const elapsedMin = (now.getTime() - new Date(log.started_at).getTime()) / 60000
    progress = Math.min(1, Math.max(0.04, elapsedMin / Math.max(1, item.default_min)))
  }

  const title =
    state === 'done' && log ? `${item.name}: ${hhmm(log.started_at, tz)}–${log.ended_at ? hhmm(log.ended_at, tz) : `about ${item.default_min} min`}` :
    state === 'running' && log ? `${item.name}: started ${hhmm(log.started_at, tz)}` : `${item.name}: not started`

  return (
    <button
      type="button"
      class="routine-item"
      data-state={state}
      aria-label={title}
      title={title}
      onPointerDown={down}
      onPointerUp={clear}
      onPointerCancel={clear}
      onPointerLeave={clear}
      onClick={click}
      onContextMenu={(e) => e.preventDefault()}
    >
      <span class="circle">
        <svg viewBox="0 0 56 56" aria-hidden="true">
          {state === 'done' ? (
            <circle class="disc" cx="28" cy="28" r="28" />
          ) : (
            <>
              <circle class="ring-bg" cx="28" cy="28" r={R} />
              {state === 'running' && (
                <circle
                  class="ring-fill"
                  cx="28" cy="28" r={R}
                  stroke-dasharray={`${CIRC * progress} ${CIRC}`}
                  transform="rotate(-90 28 28)"
                />
              )}
            </>
          )}
        </svg>
        <span class="circle-inner num">
          {state === 'idle' && <Icon name={routineIconName(item.icon, item.id)} size={24} stroke={1.6} />}
          {state === 'running' && log && elapsedLabel(log.started_at, now)}
          {state === 'done' && log && hhmm(log.ended_at ?? log.started_at, tz)}
        </span>
      </span>
      <span class="routine-label">{shortName(item)}</span>
    </button>
  )
}
