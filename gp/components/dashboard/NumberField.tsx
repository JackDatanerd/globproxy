'use client'
import { useEffect, useState } from 'react'

// A numeric input that keeps what the customer is typing. The form fields it
// replaces stored `+e.target.value` (and coerced '' to 0), so clearing the box
// snapped it to "0" and the next keystroke produced "05". Here the text is
// local; the parent only ever sees a finite number (NaN while the box is empty
// or mid-edit like "1."), and the text is re-synced when the parent changes
// the value itself (a "use all" button, a preset).
export default function NumberField({
  value, onValue, className, min, step = 'any', required, placeholder, ariaLabel,
}: {
  value: number
  onValue: (n: number) => void
  className?: string
  min?: number
  step?: string | number
  required?: boolean
  placeholder?: string
  ariaLabel?: string
}) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '')

  useEffect(() => {
    // Only overwrite the text if the parent's number really differs from what
    // the text already means — otherwise typing "1." would be rewritten to "1".
    const parsed = text.trim() === '' ? NaN : Number(text)
    if (!(Number.isNaN(parsed) && Number.isNaN(value)) && parsed !== value) {
      setText(Number.isFinite(value) ? String(value) : '')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  return (
    <input
      type="number" inputMode="decimal" min={min} step={step} required={required}
      placeholder={placeholder} aria-label={ariaLabel}
      value={text}
      onChange={e => {
        const t = e.target.value
        setText(t)
        onValue(t.trim() === '' ? NaN : Number(t))
      }}
      className={className}
    />
  )
}
