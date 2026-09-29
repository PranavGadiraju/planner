// Today's one-tap entry points into the other tabs. Each target tab handles its own '#/<tab>/<action>' segment.
import { Icon } from './Icon'
import { navigate } from '../router'

const ACTIONS = [
  { hash: '#/food/log', label: 'Log meal', icon: 'food' as const },
  { hash: '#/lift/start', label: 'Start workout', icon: 'lift' as const },
  { hash: '#/work/start', label: 'Start session', icon: 'work' as const },
]

export function QuickActions() {
  return (
    <div class="quick-actions">
      {ACTIONS.map((a) => (
        <button key={a.hash} type="button" class="btn btn-ghost quick-action" onClick={() => navigate(a.hash)}>
          <Icon name={a.icon} size={18} stroke={1.8} />
          <span>{a.label}</span>
        </button>
      ))}
    </div>
  )
}
