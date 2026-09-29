import { Icon, type IconName } from './Icon'
import { TABS, route } from '../router'

const ICONS: Record<string, IconName> = { today: 'today', food: 'food', lift: 'lift', work: 'work', day: 'day' }

export function TabBar() {
  const current = route.value.name
  return (
    <nav class="tabbar" aria-label="Sections">
      {TABS.map((t) => (
        <a key={t.route} class="tab" href={t.hash} aria-current={current === t.route ? 'page' : undefined}>
          <Icon name={ICONS[t.route] ?? 'dot'} size={22} />
          <span>{t.label}</span>
        </a>
      ))}
    </nav>
  )
}
