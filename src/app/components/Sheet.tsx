// Bottom sheet with a backdrop. Closes on backdrop tap and Escape.
import type { ComponentChildren } from 'preact'
import { useEffect } from 'preact/hooks'

export function Sheet({ title, sub, onClose, children }: { title: string; sub?: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [onClose])
  return (
    <div class="sheet-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div class="sheet-grab" />
        <h2>{title}</h2>
        {sub && <p class="sub">{sub}</p>}
        {children}
      </div>
    </div>
  )
}
