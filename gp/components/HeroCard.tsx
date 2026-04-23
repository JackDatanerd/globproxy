'use client'
import { useEffect, useState } from 'react'

export default function HeroCard() {
  const [w, setW] = useState(0)
  useEffect(() => { setTimeout(() => setW(22), 400) }, [])
  return (
    <div className="hidden lg:block bg-white border border-border rounded-2xl p-7 shadow-lg relative">
      <div className="absolute top-5 right-5 bg-accent2-light text-accent2 text-[10px] font-mono tracking-widest px-2.5 py-1 rounded-full">LIVE</div>
      <div className="text-[10px] font-mono text-muted tracking-widest uppercase mb-2">Your bandwidth</div>
      <div className="font-display text-5xl font-bold text-ink tracking-tight leading-none">284.3 GB</div>
      <div className="text-xs text-muted mt-1.5 mb-5">Never expires · Last reload 3 days ago</div>
      <div className="bg-surface rounded-full h-2 overflow-hidden mb-1.5">
        <div className="h-full rounded-full bg-gradient-to-r from-accent to-sky-400 transition-all duration-1000" style={{ width: `${w}%` }} />
      </div>
      <div className="flex justify-between text-[11px] font-mono text-muted mb-6"><span>Used: 65.7 GB</span><span>Remaining: 284.3 GB</span></div>
      <div className="text-[10px] font-mono text-muted tracking-widest uppercase mb-3">Active sessions</div>
      <div className="flex flex-col gap-2">
        {[['Session #1','US · New York'],['Session #2','UK · London'],['Session #3','DE · Berlin']].map(([s,g]) => (
          <div key={s} className="flex items-center justify-between bg-surface rounded-lg px-3.5 py-2.5">
            <span className="text-sm text-ink2">{s}</span>
            <span className="bg-accent-light text-accent text-[11px] font-mono px-2 py-0.5 rounded">{g}</span>
            <div className="w-1.5 h-1.5 rounded-full bg-accent2" />
          </div>
        ))}
      </div>
    </div>
  )
}
