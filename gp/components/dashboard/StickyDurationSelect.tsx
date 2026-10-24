'use client'
import { useEffect, useState } from 'react'

const PRESETS = [
  { value: 1, label: '1 min' }, { value: 10, label: '10 min' }, { value: 30, label: '30 min' },
  { value: 60, label: '1 hour' }, { value: 360, label: '6 hours' }, { value: 720, label: '12 hours' },
  { value: 1440, label: '24 hours' },
]
const CUSTOM = 'custom'

// Sticky lifetime picker: presets plus a custom value (1–1440 minutes — the
// range the API accepts). A session created through the API with, say, 45
// minutes used to render as "1 min" here (the value matched no option), and
// saving the form silently kept 45 while showing something else.
export default function StickyDurationSelect({
  value, onChange, disabled, className,
}: { value: number; onChange: (n: number) => void; disabled?: boolean; className: string }) {
  const isPreset = PRESETS.some(p => p.value === value)
  const [custom, setCustom] = useState(!isPreset)

  return (
    <div className="space-y-1.5">
      <select
        value={custom ? CUSTOM : String(value)}
        onChange={e => {
          if (e.target.value === CUSTOM) { setCustom(true); return }
          setCustom(false)
          onChange(Number(e.target.value))
        }}
        disabled={disabled}
        className={className}
      >
        {PRESETS.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
        <option value={CUSTOM}>Custom…</option>
      </select>
      {custom && (
        <div className="flex items-center gap-1.5">
          <MinutesInput value={value} onChange={onChange} disabled={disabled} className={className} />
          <span className="text-[10.5px] text-muted flex-shrink-0">minutes (1–1440)</span>
        </div>
      )}
    </div>
  )
}

/**
 * Free-typing minutes box. The text is local so deleting a digit (or clearing
 * the box to type a new number) isn't snapped to 1 on every keystroke — the
 * parent only ever receives a valid integer in 1–1440, so its value (and the
 * form's submit) can never be invalid. On blur the box settles on the parent's
 * last valid value, clamping an out-of-range entry.
 */
export function MinutesInput({
  value, onChange, disabled, className,
}: { value: number; onChange: (n: number) => void; disabled?: boolean; className: string }) {
  const [text, setText] = useState(Number.isFinite(value) ? String(value) : '')

  // Parent changed the value itself (a preset) — resync unless the text already means it.
  useEffect(() => {
    if (Number(text) !== value) setText(Number.isFinite(value) ? String(value) : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  const n = text.trim() === '' ? NaN : Number(text)
  const valid = Number.isInteger(n) && n >= 1 && n <= 1440

  return (
    <div>
      <input
        type="number" inputMode="numeric" min={1} max={1440} step={1}
        value={text}
        disabled={disabled}
        aria-invalid={!valid}
        onChange={e => {
          setText(e.target.value)
          const v = e.target.value.trim() === '' ? NaN : Number(e.target.value)
          if (Number.isInteger(v) && v >= 1 && v <= 1440) onChange(v)
        }}
        onBlur={() => {
          if (valid) return
          const v = Math.round(n)
          if (Number.isFinite(v)) {
            const c = Math.min(1440, Math.max(1, v))
            onChange(c); setText(String(c))
          } else {
            setText(String(value))   // empty/garbage: keep the last valid value
          }
        }}
        className={className}
      />
      {!valid && <p className="text-[10.5px] text-red-600 mt-1">Enter a whole number from 1 to 1440.</p>}
    </div>
  )
}
