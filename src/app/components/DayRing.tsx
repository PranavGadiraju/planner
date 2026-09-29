// 24-segment day ring: one arc per hour, coloured by the category with the most minutes in it. Unknown is hatched,
// hours still to come sit in the track colour. Midnight at the top, clockwise; small 0 / 6 / 12 / 18 ticks outside.
import type { ChartCategory } from '@shared/day'
import { blockColor } from '../data/daymath'

const C = 50          // centre (viewBox 0 0 100 100)
const R = 37          // arc radius
const W = 11          // stroke width
const GAP_DEG = 2.2   // breathing room between hours
const TICK_R = 46.4   // tick labels sit just outside the arc and inside the viewBox

function pt(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180
  return [C + r * Math.sin(a), C - r * Math.cos(a)]
}
function arc(h: number): string {
  const a0 = h * 15 + GAP_DEG / 2
  const a1 = (h + 1) * 15 - GAP_DEG / 2
  const [x0, y0] = pt(a0, R)
  const [x1, y1] = pt(a1, R)
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

export function DayRing({ hours, size = 160, center, id = 'ring' }: {
  hours: (ChartCategory | null)[]
  size?: number
  center?: { big: string; small: string }
  id?: string
}) {
  const hatch = `${id}-hatch`
  return (
    <svg class="ring" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <pattern id={hatch} patternUnits="userSpaceOnUse" width="3" height="3" patternTransform="rotate(45)">
          <rect width="3" height="3" fill="var(--surface-3)" />
          <line x1="0" y1="0" x2="0" y2="3" stroke="var(--cat-unknown)" stroke-width="1.1" opacity="0.7" />
        </pattern>
      </defs>
      {Array.from({ length: 24 }, (_, h) => {
        const cat = hours[h] ?? null
        const stroke = cat === null ? 'var(--surface-3)' : cat === 'unknown' ? `url(#${hatch})` : blockColor(cat, null)
        return <path key={h} d={arc(h)} fill="none" stroke={stroke} stroke-width={W} stroke-linecap="butt" opacity={cat === null ? 0.7 : 1} />
      })}
      {([0, 6, 12, 18] as const).map((h) => {
        const [x, y] = pt(h * 15, TICK_R)
        return <text key={h} x={x} y={y} font-size="4.4" font-weight="600" text-anchor="middle" dominant-baseline="central" fill="var(--text-3)">{h}</text>
      })}
      {center && (
        <>
          <text x={C} y={C + 1} font-size="15" font-weight="700" letter-spacing="-0.4" text-anchor="middle" fill="var(--text)">{center.big}</text>
          <text x={C} y={C + 10.5} font-size="5.2" font-weight="600" letter-spacing="0.4" text-anchor="middle" fill="var(--text-3)">{center.small.toUpperCase()}</text>
        </>
      )}
    </svg>
  )
}
