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
const STARTER = getPlan('starter')!
const GROWTH  = getPlan('growth')!
const SCALE   = getPlan('scale')!
const RETAIL_PRICE  = getPlan('micro')!.price

// What buying "at least `gb`" really costs. Plans are fixed packs, not a
// per-GB rate that follows the slider: the old `gb >= 500 ? Scale : gb >= 100 ?
// Growth : Starter` quoted 490 GB at the Growth rate, which is not something you
// can buy (4 Growth + 9 Starter packs come to $1,435 — and a single 500 GB Scale
// pack, $1,000, is cheaper AND bigger). So this tries every pack mix that covers
// the target and takes the cheapest; the reseller then owns (and sells) every GB
// they bought, which can be slightly more than they asked for.
function cheapestBundle(gb: number) {
  let best = { cost: Infinity, bought: 0, scale: 0, growth: 0, starter: 0 }
  for (let sc = 0; sc <= Math.ceil(gb / SCALE.gb); sc++) {
    for (let gr = 0; gr <= Math.ceil(gb / GROWTH.gb); gr++) {
      const left = Math.max(0, gb - sc * SCALE.gb - gr * GROWTH.gb)
      const st = Math.ceil(left / STARTER.gb)
      const cost = sc * SCALE.total + gr * GROWTH.total + st * STARTER.total
      const bought = sc * SCALE.gb + gr * GROWTH.gb + st * STARTER.gb
      if (cost < best.cost - 1e-9 || (Math.abs(cost - best.cost) < 1e-9 && bought < best.bought)) {
        best = { cost, bought, scale: sc, growth: gr, starter: st }
      }
    }
  }
  return best
}

export default function ResellerCalc() {
  const [gb, setGb] = useState(100)
  const bundle = cheapestBundle(gb)
  const buy = bundle.cost / bundle.bought
  const sell = RETAIL_PRICE
  const profit = sell * bundle.bought - bundle.cost
  const packs = [
    bundle.scale ? `${bundle.scale} × ${SCALE.gb} GB` : '',
    bundle.growth ? `${bundle.growth} × ${GROWTH.gb} GB` : '',
    bundle.starter ? `${bundle.starter} × ${STARTER.gb} GB` : '',
  ].filter(Boolean).join(' + ')

  return (
    <div className="bg-white border border-border rounded-2xl p-8 shadow-sm">
      <div className="font-display font-bold text-lg text-ink mb-6">Your profit calculator</div>
      <div className="mb-6">
        <div className="flex justify-between text-xs font-mono text-subtle mb-2"><span>GB to resell</span><span className="text-accent">{gb} GB</span></div>
        <input type="range" min={10} max={1000} step={10} value={gb} onChange={e => setGb(+e.target.value)} className="w-full accent-accent cursor-pointer" />
        <div className="flex justify-between text-[10px] font-mono text-subtle mt-1"><span>10 GB</span><span>1,000 GB</span></div>
      </div>
      {[
        ['You buy', `${bundle.bought} GB · ${packs}`, 'text-ink'],
        ['Cost (average)', `$${bundle.cost.toLocaleString()} · $${buy.toFixed(2)}/GB`, 'text-ink'],
        ['You sell at', `$${sell.toFixed(2)}/GB`, 'text-ink'],
        ['Margin per GB', `$${(sell-buy).toFixed(2)}/GB`, 'text-accent2-dark'],
        ['Bandwidth expiry', 'Never', 'text-accent2-dark'],
      ].map(([l,v,c]) => (
        <div key={l as string} className="flex justify-between py-3 border-b border-border last:border-none text-sm">
          <span className="text-ink2 font-light">{l}</span>
          <span className={`font-mono font-medium ${c}`}>{v}</span>
        </div>
      ))}
      <div className="bg-accent2-light rounded-xl p-4 mt-5 flex justify-between items-center">
        <span className="text-sm text-accent2-dark font-medium">Your profit on {bundle.bought} GB</span>
        <span className="font-display text-2xl font-bold text-accent2-dark">${Math.round(profit).toLocaleString()}</span>
      </div>
    </div>
  )
}
