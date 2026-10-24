// Shared business constants. Kept here rather than inlined wherever
// they're used so the admin overview page and the per-cycle sales
// report can't silently drift out of sync with each other.

// What the proxy bandwidth costs us per GB, in USD. Used to estimate COGS on both
// /admin (all-time) and /admin/cycles (per biweekly cycle).
//
// It is deliberately NOT a literal in the source: this repository is readable by
// anyone who can see it, and a wholesale price is exactly what a customer (or a
// competitor) could use to undercut us. It lives in the UPSTREAM_COST_PER_GB_USD
// Worker setting instead (pushed by .github/workflows/deploy.yml from the matching
// GitHub secret). Returns null when it is missing or unusable, so the admin pages
// can say "not set" rather than quietly showing a cost of $0 and an inflated profit.
export function upstreamCostPerGbUsd(): number | null {
  const raw = process.env.UPSTREAM_COST_PER_GB_USD?.trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}
