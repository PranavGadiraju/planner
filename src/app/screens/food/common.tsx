// Pieces shared by the Food screens: long-press, slot chips, the grams pad with live kcal, and the two logging sheets.
import { useRef, useState } from 'preact/hooks'
import type { Food, FoodLog, Meal, Slot } from '@shared/types'
import type { Per100 } from '@shared/nutrition'
import { localParts, zonedToUTC } from '@shared/tz'
import { Sheet } from '../../components/Sheet'
import { Icon } from '../../components/Icon'
import { toast } from '../../components/Toast'
import { SLOTS, SLOT_LABELS, fmtKcal, fmtNum, foodSnapshot, logFood, logMeal, mealSnapshot, slotAt } from '../../data/food'

const LONG_PRESS_MS = 500

/** Pointer handlers for tap vs long-press (500 ms) on one element. */
export function useLongPress(onTap: () => void, onLong: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }
  return {
    onPointerDown: () => {
      fired.current = false
      clear()
      timer.current = setTimeout(() => { fired.current = true; timer.current = null; onLong() }, LONG_PRESS_MS)
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave: clear,
    onClick: () => { clear(); if (fired.current) { fired.current = false; return } onTap() },
    onContextMenu: (e: Event) => e.preventDefault(),
  }
}

/** The instant a log lands on: now for today, else the same wall-clock time on the chosen day. */
export function atFor(day: string, today: string, zone: string): Date {
  const now = new Date()
  if (day === today) return now
  const p = localParts(now, zone)
  return zonedToUTC(day, `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`, zone)
}

export function SlotChips({ value, onChange }: { value: Slot | null; onChange: (s: Slot) => void }) {
  return (
    <div class="chips" role="group" aria-label="Slot">
      {SLOTS.map((s) => (
        <button key={s} type="button" class="chip-cat" aria-pressed={value === s} style="--c: var(--cat-meal)" onClick={() => onChange(s)}>
          {SLOT_LABELS[s]}
        </button>
      ))}
    </div>
  )
}

const numVal = (e: Event) => Number((e.currentTarget as HTMLInputElement).value)

/** Chips (1 serving, 50, 100, 150, 200 g), a numeric input and the live kcal / P / C / F for those grams. */
export function GramsPad({ food, grams, onChange, autoFocus }: { food: Per100 & { serving_g?: number | null }; grams: number; onChange: (g: number) => void; autoFocus?: boolean }) {
  const m = foodSnapshot(food, grams > 0 ? grams : 0)
  const serving = food.serving_g && food.serving_g > 0 ? food.serving_g : null
  const chips: { label: string; g: number }[] = []
  if (serving) chips.push({ label: `1 serving (${fmtNum(serving)} g)`, g: serving })
  for (const g of [50, 100, 150, 200]) chips.push({ label: `${g}`, g })
  return (
    <div class="grams-pad">
      <div class="chips">
        {chips.map((c) => (
          <button key={c.label} type="button" class="chip" aria-pressed={grams === c.g} onClick={() => onChange(c.g)}>{c.label}</button>
        ))}
      </div>
      <div class="row">
        <input
          class="grams-input num"
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={grams > 0 ? String(grams) : ''}
          placeholder="grams"
          aria-label="Grams"
          autofocus={autoFocus}
          onInput={(e) => onChange(numVal(e))}
          enterkeyhint="done"
        />
        <span class="small muted">g</span>
        <span class="grow" />
        <span class="grams-live num">
          <b>{fmtKcal(m.kcal)} kcal</b>
          <span class="faint"> · {Math.round(m.protein_g)}P {Math.round(m.carb_g)}C {Math.round(m.fat_g)}F</span>
        </span>
      </div>
    </div>
  )
}

/** Log a food: grams pad + slot chips -> one food_log row. */
export function LogFoodSheet({ food, at, zone, onDone, onClose, initialGrams }: {
  food: Food
  at: Date
  zone: string
  initialGrams?: number
  onDone: (entry: FoodLog) => void
  onClose: () => void
}) {
  const [grams, setGrams] = useState(initialGrams ?? (food.serving_g && food.serving_g > 0 ? food.serving_g : 100))
  const [slot, setSlot] = useState<Slot>(slotAt(at, zone))
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (!(grams > 0)) { toast('Enter the grams', { kind: 'danger' }); return }
    setBusy(true)
    try {
      const entry = await logFood(food, grams, slot, at)
      onDone(entry)
    } finally { setBusy(false) }
  }
  return (
    <Sheet title={food.name} sub={`${food.brand ? `${food.brand} · ` : ''}${fmtKcal(food.kcal_100)} kcal / 100 g${food.serving_text ? ` · ${food.serving_text}` : ''}`} onClose={onClose}>
      <div class="stack">
        <div class="sheet-source"><SourceBadge source={food.source} /></div>
        <GramsPad food={food} grams={grams} onChange={setGrams} />
        <SlotChips value={slot} onChange={setSlot} />
        <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => void save()} disabled={busy}>
          <Icon name="check" size={20} /> Log {grams > 0 ? `${fmtNum(grams)} g` : ''}
        </button>
      </div>
    </Sheet>
  )
}

const SCALES = [0.5, 1, 1.5, 2]

/** Log a meal at a portion: 0.5x / 1x / 1.5x / 2x chips or grams (converted through the meal's total grams). */
export function PortionSheet({ meal, at, zone, onDone, onClose }: { meal: Meal; at: Date; zone: string; onDone: (entry: FoodLog) => void; onClose: () => void }) {
  const [scale, setScale] = useState(1)
  const [gramsText, setGramsText] = useState('')
  const [slot, setSlot] = useState<Slot>(meal.default_slot ?? slotAt(at, zone))
  const [busy, setBusy] = useState(false)
  const m = mealSnapshot(meal, scale)
  const pickGrams = (g: number) => {
    setGramsText(g > 0 ? String(g) : '')
    if (meal.total_g > 0 && g > 0) setScale(Math.round((g / meal.total_g) * 100) / 100)
  }
  const pickScale = (s: number) => { setScale(s); setGramsText('') }
  const save = async () => {
    if (!(scale > 0)) { toast('Pick a portion', { kind: 'danger' }); return }
    setBusy(true)
    try {
      onDone(await logMeal(meal, scale, slot, at))
    } finally { setBusy(false) }
  }
  return (
    <Sheet title={meal.name} sub={`${fmtKcal(meal.kcal)} kcal · ${Math.round(meal.protein_g)}P ${Math.round(meal.carb_g)}C ${Math.round(meal.fat_g)}F at 1x · ${fmtNum(meal.total_g)} g`} onClose={onClose}>
      <div class="stack">
        <div class="grams-pad">
          <div class="chips">
            {SCALES.map((s) => (
              <button key={s} type="button" class="chip" aria-pressed={scale === s && !gramsText} onClick={() => pickScale(s)}>{s}x</button>
            ))}
          </div>
          <div class="row">
            <input class="grams-input num" type="number" inputMode="decimal" min={0} step="any" value={gramsText} placeholder="grams" aria-label="Grams" onInput={(e) => pickGrams(numVal(e))} enterkeyhint="done" disabled={!(meal.total_g > 0)} />
            <span class="small muted">g</span>
            <span class="grow" />
            <span class="grams-live num"><b>{fmtKcal(m.kcal)} kcal</b><span class="faint"> · {Math.round(m.protein_g)}P {Math.round(m.carb_g)}C {Math.round(m.fat_g)}F</span></span>
          </div>
        </div>
        <SlotChips value={slot} onChange={setSlot} />
        <button type="button" class="btn btn-primary btn-big btn-block" onClick={() => void save()} disabled={busy}>
          <Icon name="check" size={20} /> Log {fmtNum(scale)}x
        </button>
      </div>
    </Sheet>
  )
}

/** Badge text for a food's source: where its numbers came from. */
export function sourceLabel(source: Food['source']): string {
  return source === 'off' ? 'Open Food Facts' : source === 'usda' ? 'USDA' : source === 'claude' ? 'from Claude' : 'label'
}

/** True for sources worth flagging in a dense list row (anything but a label typed by hand). */
export function showSourceInRow(source: Food['source']): boolean {
  return source !== 'label'
}

/** "OFF" / "USDA" / "label" / "Claude" source badge. */
export function SourceBadge({ source }: { source: Food['source'] }) {
  return <span class={`badge${source === 'claude' ? ' badge-sleep' : ''}`} title={source === 'claude' ? 'Added by Claude Code from a label photo' : undefined}>{sourceLabel(source)}</span>
}

export function MacroLine({ p }: { p: Per100 }) {
  return (
    <span class="small muted num">
      {fmtKcal(p.kcal_100)} kcal · {fmtNum(p.protein_100)}P {fmtNum(p.carb_100)}C {fmtNum(p.fat_100)}F / 100 g
    </span>
  )
}
