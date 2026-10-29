import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parsePromo, serializePromo, promoState, activePromo, applyPercent, validPercent, extendedEnd, endProblem,
  formatUtc, publicPromo, MAX_PROMO_PCT, MAX_PROMO_DAYS,
} from '../lib/promo.ts'
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

const NOV6_END = '2026-11-06T23:59:00.000Z'
const mk = (o = {}) => ({ enabled: true, percent: 10, startsAt: null, endsAt: NOV6_END, label: 'Launch', ...o })
const at = (iso) => Date.parse(iso)

test('the offer is live strictly before its end instant, in UTC', () => {
  const p = mk()
  assert.equal(promoState(p, at('2026-10-30T00:00:00Z')), 'live')
  assert.equal(promoState(p, at('2026-11-06T23:58:59Z')), 'live')
  assert.equal(promoState(p, at(NOV6_END)), 'ended')
  assert.equal(promoState(p, at('2026-11-07T00:00:00Z')), 'ended')
  assert.equal(activePromo(p, at('2026-11-07T00:00:00Z')), null)
})

test('scheduled, paused and missing offers never discount', () => {
  assert.equal(promoState(mk({ startsAt: '2026-11-01T00:00:00.000Z' }), at('2026-10-30T00:00:00Z')), 'scheduled')
  assert.equal(activePromo(mk({ startsAt: '2026-11-01T00:00:00.000Z' }), at('2026-10-30T00:00:00Z')), null)
  assert.equal(promoState(mk({ enabled: false }), at('2026-10-30T00:00:00Z')), 'off')
  assert.equal(promoState(null), 'off')
  assert.equal(activePromo(null), null)
})

test('a corrupt or out-of-range stored value is "no offer", never a surprise discount', () => {
  for (const bad of [null, undefined, '', 'nope', '[]', '{}', '{"enabled":true}',
    JSON.stringify({ enabled: true, percent: 0, endsAt: NOV6_END }),
    JSON.stringify({ enabled: true, percent: -5, endsAt: NOV6_END }),
    JSON.stringify({ enabled: true, percent: 99, endsAt: NOV6_END }),
    JSON.stringify({ enabled: true, percent: '10', endsAt: NOV6_END }),
    JSON.stringify({ enabled: true, percent: 10, endsAt: 'garbage' }),
    JSON.stringify({ enabled: true, percent: 10, endsAt: NOV6_END, startsAt: '2026-12-01T00:00:00Z' })]) {
    assert.equal(parsePromo(bad), null, String(bad))
  }
  // a truthy-but-not-true "enabled" is off
  assert.equal(parsePromo(JSON.stringify({ enabled: 'yes', percent: 10, endsAt: NOV6_END })).enabled, false)
})

test('serialize / parse round-trips', () => {
  const p = mk({ startsAt: '2026-10-30T08:00:00.000Z' })
  assert.deepEqual(parsePromo(serializePromo(p)), p)
})

test('the discount is applied to the cent and never reaches zero', () => {
  assert.equal(applyPercent(35, 10), 31.5)
  assert.equal(applyPercent(4.5, 10), 4.05)
  assert.equal(applyPercent(280, 10), 252)
  assert.equal(applyPercent(1000, 12.5), 875)
  assert.equal(applyPercent(0.01, 50), 0.01)
  assert.equal(applyPercent(35, 0), 35)
  assert.equal(applyPercent(0, 10), 0)
})

test('percent validation: 0 < p <= max, at most 2 decimals', () => {
  assert.ok(validPercent(10) && validPercent(0.5) && validPercent(12.25) && validPercent(MAX_PROMO_PCT))
  for (const v of [0, -1, MAX_PROMO_PCT + 1, NaN, Infinity, '10', null, 10.123]) assert.equal(validPercent(v), false, String(v))
})

test('extending: a live offer moves its end later; an ended one restarts from now', () => {
  const live = mk()
  assert.equal(extendedEnd(live, 24, at('2026-11-01T00:00:00Z')), '2026-11-07T23:59:00.000Z')
  const ended = mk({ endsAt: '2026-11-06T23:59:00.000Z' })
  assert.equal(extendedEnd(ended, 24, at('2026-11-10T12:00:00Z')), '2026-11-11T12:00:00.000Z')
})

test('end-time guard rejects typos and inverted ranges', () => {
  const now = at('2026-10-29T00:00:00Z')
  assert.equal(endProblem(NOV6_END, null, now), null)
  assert.match(endProblem('2062-01-01T00:00:00Z', null, now), /days ahead/)
  assert.match(endProblem(NOV6_END, '2026-12-01T00:00:00Z', now), /after it starts/)
  assert.match(endProblem('x', null, now), /valid date/)
  assert.ok(MAX_PROMO_DAYS >= 8)
})

test('deadlines are always printed in UTC', () => {
  assert.equal(formatUtc(NOV6_END), '6 Nov 2026, 23:59 UTC')
  assert.deepEqual(publicPromo(mk()), { percent: 10, ends_at: NOV6_END, label: 'Launch' })
  assert.equal(publicPromo(null), null)
})

test('checkout prices M-Pesa on the discounted total and records the list price; card is untouched', () => {
  const r = read('app/api/checkout/route.ts')
  assert.match(r, /applyPercent\(planData\.total, quote\.promo\.percent\)/)
  assert.match(r, /kesFor\(priced\.total, quote\.rate\)/)
  assert.match(r, /startCheckout\(supabase, \{ id: user\.id, email: user\.email \}, priced, kes,/)
  // the offer is only ever read inside the M-Pesa branch
  assert.ok(r.indexOf('quote.promo') > r.indexOf("method === 'mpesa'"))
  const c = read('lib/checkout.ts')
  assert.match(c, /const promo = kes \? opts\.promo : undefined/)
  assert.match(c, /list_usd: promo\.listUsd, discount_pct: promo\.pct/)
})

test('a price change (rate OR offer) is a 409 that carries the current offer', () => {
  const r = read('app/api/checkout/route.ts')
  assert.match(r, /rate_changed: true, rate: quote\.rate, amount_kes: amount, promo: publicPromo\(quote\.promo\)/)
  const b = read('app/dashboard/buy/page.tsx')
  assert.match(b, /setPromo\(next\)/)
  assert.match(b, /The M-Pesa offer has ended/)
})

test('the offer is read in the same query as the rate, and the migration pins the new columns', () => {
  assert.match(read('lib/fx.ts'), /\['mpesa_enabled', 'kes_fx_markup_pct', 'kes_fx_manual', 'kes_fx_cache', PROMO_KEY\]/)
  const m = read('supabase/migrations/0107_mpesa_promo.sql')
  assert.match(m, /new\.list_usd\s+:= old\.list_usd/)
  assert.match(m, /new\.discount_pct\s+:= old\.discount_pct/)
  // the rest of the pinned list survived the redefinition
  for (const col of ['amount_usd', 'pay_amount', 'tax_rate_pct', 'auto_recharge', 'invoice_number', 'refunded_usd']) {
    assert.match(m, new RegExp(`new\\.${col}\\s+:= old\\.${col}`), col)
  }
})

test('admin route: every change is audited and guarded against a stale page', () => {
  const a = read('app/api/admin/mpesa-promo/route.ts')
  for (const act of ['create', 'edit', 'extend', 'end', 'pause', 'resume', 'remove']) assert.match(a, new RegExp(`mpesa\\.promo\\.${act}`), act)
  assert.match(a, /body\.version !== undefined/)
  assert.match(a, /\.eq\('value', prevRaw\)/)
})
