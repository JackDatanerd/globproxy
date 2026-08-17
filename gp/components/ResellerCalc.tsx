'use client'
import { useState } from 'react'
import { getPlan } from '@/lib/plans'

// `buy` and `sell` used to both be hardcoded here — `buy` duplicated the
// Starter/Growth/Scale per-GB prices from lib/plans.ts (exactly the kind
// of drift-prone duplication that file's own header comment warns about),
// and `sell` was `buy + 2.20`, a fixed markup that just rides along with
// whatever tier `buy` lands on. That second part meant "Margin per GB"
// never actually moved as the slider crossed tier boundaries — a reseller
// buying at the Scale rate saw the exact same margin as one buying at
// Starter, which undersells the real incentive to commit to volume.
//
// Fix: read `buy` from the real plan tiers (one source of truth, stays in
// sync if pricing ever changes), and peg `sell` to what GlobProxy itself
// charges retail at the Micro tier — roughly what a reseller's own end
// customers would expect to pay. Margin then correctly widens as the
// wholesale price drops at higher volume, which is the actual mechanic
// this calculator exists to demonstrate.
const STARTER_PRICE = getPlan('starter')!.price
const GROWTH_PRICE  = getPlan('growth')!.price
const SCALE_PRICE   = getPlan('scale')!.price
const RETAIL_PRICE  = getPlan('micro')!.price

export default function ResellerCalc() {
  const [gb, setGb] = useState(100)
  const buy = gb >= 500 ? SCALE_PRICE : gb >= 100 ? GROWTH_PRICE : STARTER_PRICE
  const sell = RETAIL_PRICE
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
