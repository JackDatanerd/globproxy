'use client'
import { useState } from 'react'

export default function ResellerCalc() {
  const [gb, setGb] = useState(100)
  const buy = gb >= 500 ? 2.00 : gb >= 100 ? 2.80 : 3.50
  const sell = buy + 2.20
  const profit = (sell - buy) * gb

  return (
    <div className="bg-white border border-border rounded-2xl p-8 shadow-sm">
      <div className="font-display font-bold text-lg text-ink mb-6">Your profit calculator</div>
      <div className="mb-6">
        <div className="flex justify-between text-xs font-mono text-muted mb-2"><span>GB to resell</span><span className="text-accent">{gb} GB</span></div>
        <input type="range" min={10} max={1000} step={10} value={gb} onChange={e => setGb(+e.target.value)} className="w-full accent-accent cursor-pointer" />
        <div className="flex justify-between text-[10px] font-mono text-muted mt-1"><span>10 GB</span><span>1,000 GB</span></div>
      </div>
      {[
        ['You buy at', `$${buy.toFixed(2)}/GB`, 'text-ink'],
        ['You sell at', `$${sell.toFixed(2)}/GB`, 'text-ink'],
        ['Margin per GB', `$${(sell-buy).toFixed(2)}/GB`, 'text-accent2'],
        ['Bandwidth expiry', 'Never', 'text-accent2'],
      ].map(([l,v,c]) => (
        <div key={l as string} className="flex justify-between py-3 border-b border-border last:border-none text-sm">
          <span className="text-ink2 font-light">{l}</span>
          <span className={`font-mono font-medium ${c}`}>{v}</span>
        </div>
      ))}
      <div className="bg-accent2-light rounded-xl p-4 mt-5 flex justify-between items-center">
        <span className="text-sm text-accent2 font-medium">Your profit on {gb} GB</span>
        <span className="font-display text-2xl font-bold text-accent2">${Math.round(profit).toLocaleString()}</span>
      </div>
    </div>
  )
}
