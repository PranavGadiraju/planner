// Global toast stack. toast('Run done · 41 min'), toast('Update ready', { action: { label: 'Reload', fn } , sticky: true })
import { signal } from '@preact/signals'

export interface ToastItem {
  id: number
  message: string
  kind: 'default' | 'danger'
  action?: { label: string; fn: () => void }
  sticky?: boolean
}

export const toasts = signal<ToastItem[]>([])
let seq = 0

export function toast(message: string, opts: { kind?: ToastItem['kind']; action?: ToastItem['action']; sticky?: boolean; duration?: number } = {}): void {
  const id = ++seq
  const item: ToastItem = { id, message, kind: opts.kind ?? 'default', action: opts.action, sticky: opts.sticky }
  toasts.value = [...toasts.value.slice(-2), item]
  if (!opts.sticky) setTimeout(() => dismiss(id), opts.duration ?? 3200)
}

export function dismiss(id: number): void {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

export function Toasts() {
  const items = toasts.value
  if (items.length === 0) return null
  return (
    <div class="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} class={`toast${t.kind === 'danger' ? ' toast-danger' : ''}`}>
          <span class="grow">{t.message}</span>
          {t.action && (
            <button type="button" onClick={() => { t.action?.fn(); dismiss(t.id) }}>{t.action.label}</button>
          )}
          {t.sticky && !t.action && <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>}
        </div>
      ))}
    </div>
  )
}
