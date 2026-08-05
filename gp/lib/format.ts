/**
 * Canonical display formatting for bandwidth numbers.
 *
 * Before this, every page picked its own `toFixed()` depth ad hoc —
 * dashboard/proxies and NewProxyForm used 2 decimals, reseller/users and
 * reseller/earnings used 1, dashboard/page.tsx used both in the same file
 * for the same `total` value, and a few spots (ProxyCard's collapsed row,
 * the usage page's per-session row) printed `gb_allocated` completely raw
 * next to a rounded `gb_used`. None of that is a data bug — it's the same
 * underlying number every time — but a 0.05 GB allocation next to a
 * used figure rounded to 1 decimal reads as "0.1 / 0.05 GB", which looks
 * like used exceeded allocated when it didn't. Route every GB/percentage
 * display through these two so a balance always reads the same way
 * wherever it's shown, and small (sub-1GB) values don't lose the
 * precision that actually distinguishes used from allocated.
 */

export function formatGb(value: number | null | undefined): string {
  return (value ?? 0).toFixed(2)
}

/**
 * Used/total as a percentage, clamped to 100 for display. The ratio can
 * legitimately tick slightly past 100 (usage-sync lag against the
 * provider's own hard cap) — every progress bar already clamps its width
 * the same way with `Math.min(pct, 100)`; this keeps the percentage *text*
 * next to it from disagreeing with what the bar shows (e.g. a full bar
 * next to "142%").
 */
export function formatPct(used: number, total: number, decimals = 1): string {
  if (!total || total <= 0) return (0).toFixed(decimals)
  return Math.min((used / total) * 100, 100).toFixed(decimals)
}
