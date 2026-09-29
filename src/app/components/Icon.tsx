// Small inline icon set (24px grid, 1.75px strokes). No icon font, no library.
import type { JSX } from 'preact'

export type IconName =
  | 'gear' | 'refresh' | 'back' | 'chevron' | 'up' | 'down' | 'check' | 'plus' | 'x' | 'copy'
  | 'today' | 'food' | 'lift' | 'work' | 'day' | 'moon' | 'sun' | 'bed'
  | 'shower' | 'run' | 'stretch' | 'shoulders' | 'journal' | 'dot' | 'tag' | 'list' | 'link' | 'trash'

const PATHS: Record<IconName, JSX.Element> = {
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  refresh: <><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></>,
  back: <path d="M15 5l-7 7 7 7" />,
  chevron: <path d="M9 5l7 7-7 7" />,
  up: <path d="M5 15l7-7 7 7" />,
  down: <path d="M5 9l7 7 7-7" />,
  check: <path d="M5 12l5 5L20 7" />,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  x: <><path d="M6 6l12 12" /><path d="M18 6L6 18" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a1 1 0 0 1 1-1h10" /></>,
  today: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  food: <><path d="M4 3v7a3 3 0 0 0 3 3v8" /><path d="M10 3v7a3 3 0 0 1-3 3" /><path d="M7 3v5" /><path d="M18 3c-2 1-3 4-3 8h3v10" /></>,
  lift: <><path d="M3 10v4" /><path d="M6 8v8" /><path d="M9 6v12" /><path d="M15 6v12" /><path d="M18 8v8" /><path d="M21 10v4" /><path d="M9 12h6" /></>,
  work: <><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M3 12h18" /></>,
  day: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18" /><path d="M8 3v4" /><path d="M16 3v4" /></>,
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="M4.9 4.9l1.4 1.4" /><path d="M17.7 17.7l1.4 1.4" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="M4.9 19.1l1.4-1.4" /><path d="M17.7 6.3l1.4-1.4" /></>,
  bed: <><path d="M3 18v-8a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v8" /><path d="M3 14h18" /><path d="M7 10V7h4v3" /><path d="M3 18v2" /><path d="M21 18v2" /></>,
  shower: <><path d="M4 4a5 5 0 0 1 9 3" /><path d="M13 7h4" /><path d="M9 11h12" /><path d="M11 14v1" /><path d="M15 14v1" /><path d="M19 14v1" /><path d="M13 18v1" /><path d="M17 18v1" /></>,
  run: <><circle cx="15" cy="4" r="1.6" /><path d="M9 20l3-6 3 2 2 4" /><path d="M12 14l-1-5 4-1 2 3 3 1" /><path d="M11 9l-4 2-1 4" /></>,
  stretch: <><circle cx="12" cy="4" r="1.6" /><path d="M12 6v7" /><path d="M5 9l7-1 7 1" /><path d="M12 13l-4 8" /><path d="M12 13l4 8" /></>,
  shoulders: <><circle cx="12" cy="5" r="1.6" /><path d="M12 8v7" /><path d="M4 12c3-3 13-3 16 0" /><path d="M12 15l-3 6" /><path d="M12 15l3 6" /></>,
  journal: <><path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" /><path d="M9 8h6" /><path d="M9 12h6" /><path d="M9 16h3" /></>,
  dot: <circle cx="12" cy="12" r="4" />,
  tag: <><path d="M3 12V4h8l9 9-8 8z" /><circle cx="7" cy="8" r="1.2" /></>,
  list: <><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  trash: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /></>,
}

export function Icon({ name, size = 22, stroke = 1.75, class: cls }: { name: IconName; size?: number; stroke?: number; class?: string }) {
  return (
    <svg
      class={cls}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={stroke}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  )
}

const ROUTINE_ICONS: Record<string, IconName> = { shower: 'shower', run: 'run', stretch: 'stretch', shoulders: 'shoulders', journal: 'journal' }
export function routineIconName(icon: string | null, id: string): IconName {
  return ROUTINE_ICONS[icon ?? ''] ?? ROUTINE_ICONS[id] ?? 'dot'
}
