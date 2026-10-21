'use client'
import { useState } from 'react'

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
          <input
            type="number" inputMode="numeric" min={1} max={1440} step={1}
            value={Number.isFinite(value) ? value : ''}
            disabled={disabled}
            onChange={e => {
              const n = Math.round(Number(e.target.value))
              onChange(Number.isFinite(n) ? Math.min(1440, Math.max(1, n)) : 1)
            }}
            className={className}
          />
          <span className="text-[10.5px] text-muted flex-shrink-0">minutes</span>
        </div>
      )}
    </div>
  )
}
