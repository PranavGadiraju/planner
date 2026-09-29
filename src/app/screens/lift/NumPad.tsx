// Numeric pad sheet for weight / reps (the steppers cover most taps; this is for a jump like 95 -> 185).
import { useState } from 'preact/hooks'
import { Sheet } from '../../components/Sheet'
import { Icon } from '../../components/Icon'

export function NumPad({ title, unit, value, decimals, onDone, onClose }: {
  title: string
  unit: string
  value: number
  decimals: boolean
  onDone: (v: number) => void
  onClose: () => void
}) {
  // Start empty: the first digit replaces the old value (the usual calculator feel); the old value stays visible as a hint.
  const [text, setText] = useState('')
  const shown = text === '' ? String(Number(value.toFixed(2))) : text
  const push = (k: string) => {
    if (k === '.') {
      if (!decimals || text.includes('.')) return
      setText(text === '' ? '0.' : `${text}.`)
      return
    }
    if (text.length >= 6) return
    setText(text === '0' ? k : `${text}${k}`)
  }
  const back = () => setText(text.slice(0, -1))
  const done = () => {
    const n = text === '' ? value : Number(text)
    if (Number.isFinite(n)) onDone(Math.max(0, n))
    onClose()
  }
  return (
    <Sheet title={title} onClose={onClose}>
      <div class="numpad-display" aria-live="polite">
        <span class="sr-only">Value</span>
        <b style={text === '' ? { color: 'var(--text-3)' } : undefined}>{shown}</b>
        {text !== '' && <i class="cursor" />}
        <span>{unit}</span>
      </div>
      <div class="numpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
          <button key={k} type="button" onClick={() => push(k)}>{k}</button>
        ))}
        <button type="button" class="key-ghost" onClick={() => push('.')} disabled={!decimals}>.</button>
        <button type="button" onClick={() => push('0')}>0</button>
        <button type="button" class="key-ghost" onClick={back} aria-label="Delete last digit"><Icon name="back" /></button>
      </div>
      <button type="button" class="btn btn-primary btn-big btn-block" style={{ marginTop: '12px' }} onClick={done}>
        <Icon name="check" size={20} /> Done
      </button>
    </Sheet>
  )
}
