import type { createAdminClient } from '@/lib/supabase/server'

// USD → KES for M-Pesa checkout. Prices are in USD; M-Pesa can only settle in
// shillings, so each M-Pesa order locks a KES amount at the moment it is
// created (orders.pay_amount / fx_rate) and that amount is what Paystack is
// asked to charge and what verification expects.
//
// Where the rate comes from, in order:
//   1. a cached market rate younger than FRESH_MS (stored in platform_settings
//      so every Worker isolate shares it),
//   2. a live fetch from a free public FX feed (two independent sources — the
//      first that answers with a sane number wins),
//   3. the cached rate if it is not older than STALE_MS (feed is down),
//   4. the admin's manual fallback rate (Admin → Settings),
//   5. otherwise M-Pesa is unavailable — we never guess a rate.
// The customer's rate is the market rate plus an admin-set markup (default 2%)
// that covers spread and drift between quote and settlement.

type Admin = Awaited<ReturnType<typeof createAdminClient>>

const FRESH_MS = 6 * 60 * 60 * 1000
const STALE_MS = 72 * 60 * 60 * 1000
const MIN_RATE = 50    // KES per USD sanity band — far outside anything real,
const MAX_RATE = 500   // so a garbage feed can never set a price
const MAX_JUMP = 0.15  // reject a fresh rate that moved >15% from the last good one
export const DEFAULT_MARKUP_PCT = 2
export const MAX_MARKUP_PCT = 10

export interface KesQuote {
  rate: number          // KES per USD charged to the customer (market + markup), 4 dp
  market: number        // KES per USD before markup
  markupPct: number
  source: 'live' | 'cache' | 'stale-cache' | 'manual'
  asOf: string | null   // ISO time the market rate was fetched (null for manual)
}

export interface MpesaConfig {
  enabled: boolean
  markupPct: number
  manualRate: number | null
  cache: { mid: number; fetched_at: string } | null
}

const saneRate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= MIN_RATE && n <= MAX_RATE

async function fetchJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// Each source returns KES per 1 USD or throws.
const SOURCES: Array<{ name: string; get: () => Promise<number> }> = [
  {
    name: 'open.er-api.com',
    get: async () => {
      const j = await fetchJson('https://open.er-api.com/v6/latest/USD')
      if (j?.result && j.result !== 'success') throw new Error('provider error')
      return Number(j?.rates?.KES)
    },
  },
  {
    name: 'currency-api',
    get: async () => {
      const j = await fetchJson('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json')
      return Number(j?.usd?.kes)
    },
  },
]

export async function loadMpesaConfig(supabase: Admin): Promise<MpesaConfig> {
  const { data, error } = await supabase
    .from('platform_settings').select('key, value')
    .in('key', ['mpesa_enabled', 'kes_fx_markup_pct', 'kes_fx_manual', 'kes_fx_cache'])
  if (error) throw error
  const m = new Map((data ?? []).map(r => [r.key, r.value as string]))

  const markupRaw = Number(m.get('kes_fx_markup_pct'))
  const markupPct = Number.isFinite(markupRaw) && m.get('kes_fx_markup_pct') !== '' && m.get('kes_fx_markup_pct') != null
    ? Math.min(Math.max(markupRaw, 0), MAX_MARKUP_PCT) : DEFAULT_MARKUP_PCT

  const manual = Number(m.get('kes_fx_manual'))
  let cache: MpesaConfig['cache'] = null
  try {
    const c = JSON.parse(m.get('kes_fx_cache') || 'null')
    if (c && saneRate(c.mid) && typeof c.fetched_at === 'string' && !Number.isNaN(Date.parse(c.fetched_at))) cache = { mid: c.mid, fetched_at: c.fetched_at }
  } catch { /* empty / corrupt cache = no cache */ }

  return {
    enabled: m.get('mpesa_enabled') !== 'false', // absent/anything-else = on; admin switches it off explicitly
    markupPct,
    manualRate: saneRate(manual) ? manual : null,
    cache,
  }
}

// Returns the rate to quote/charge, or null when M-Pesa is switched off or no
// trustworthy rate exists. Never throws on a feed failure (that falls back);
// a settings read failure does throw so callers can 500 rather than guess.
export async function getKesQuote(supabase: Admin): Promise<KesQuote | null> {
  const cfg = await loadMpesaConfig(supabase)
  if (!cfg.enabled) return null

  const finish = (market: number, source: KesQuote['source'], asOf: string | null): KesQuote => ({
    market,
    markupPct: cfg.markupPct,
    rate: Math.round(market * (1 + cfg.markupPct / 100) * 10000) / 10000,
    source,
    asOf,
  })

  const ageMs = cfg.cache ? Date.now() - Date.parse(cfg.cache.fetched_at) : Infinity
  if (cfg.cache && ageMs < FRESH_MS) return finish(cfg.cache.mid, 'cache', cfg.cache.fetched_at)

  for (const src of SOURCES) {
    try {
      const mid = await src.get()
      if (!saneRate(mid)) throw new Error(`implausible rate ${mid}`)
      if (cfg.cache && Math.abs(mid / cfg.cache.mid - 1) > MAX_JUMP && ageMs < STALE_MS) {
        throw new Error(`rate ${mid} moved >${MAX_JUMP * 100}% from last good ${cfg.cache.mid}`)
      }
      const fetchedAt = new Date().toISOString()
      const { error } = await supabase.from('platform_settings')
        .upsert({ key: 'kes_fx_cache', value: JSON.stringify({ mid, fetched_at: fetchedAt, source: src.name }), updated_at: fetchedAt })
      if (error) console.error('[fx] could not cache rate', error) // the live rate is still usable
      return finish(mid, 'live', fetchedAt)
    } catch (e) {
      console.error(`[fx] ${src.name} failed:`, e instanceof Error ? e.message : e)
    }
  }

  if (cfg.cache && ageMs < STALE_MS) return finish(cfg.cache.mid, 'stale-cache', cfg.cache.fetched_at)
  if (cfg.manualRate) return finish(cfg.manualRate, 'manual', null)
  return null
}

// Whole shillings, rounded UP: M-Pesa settles in whole KES, and rounding up
// means rounding never costs us money.
export function kesFor(usd: number, rate: number): number {
  return Math.ceil(Math.round(usd * rate * 1e6) / 1e6)
}
