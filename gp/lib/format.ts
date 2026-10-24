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
  // NaN (an emptied number field) must not print as "NaN".
  return (Number.isFinite(value as number) ? (value as number) : 0).toFixed(2)
}

/**
 * Like formatGb, but a small non-zero amount is shown in MB instead of being
 * flattened to "0.00" (per-host rows are routinely a few MB).
 */
export function formatGbPrecise(value: number | null | undefined): string {
  const v = value ?? 0
  if (v > 0 && v < 0.01) {
    const mb = v * 1024
    return `${mb < 1 ? mb.toFixed(2) : mb.toFixed(1)} MB`
  }
  return formatGb(v)
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

/**
 * Canonical USD display: always two decimals with thousands separators
 * ("$4.50", "$35.00", "$1,000.00"). Billing, buy and pricing used to each
 * print raw numbers ("$4.5", "$35") next to toFixed(2) figures elsewhere.
 */
export function formatUsd(value: number | string | null | undefined): string {
  const n = Number(value ?? 0)
  return '$' + (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Human label for a sticky lifetime in minutes: 45 -> "45 min", 60 -> "1 hr",
 * 100 -> "1 hr 40 min", 1440 -> "24 hr". (A raw `min / 60` printed
 * "1.6666666666666667hr" for 100.)
 */
export function formatDurationMinutes(min: number | null | undefined): string {
  const m = Math.round(Number(min))
  if (!Number.isFinite(m) || m <= 0) return '—'
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60), r = m % 60
  return r === 0 ? `${h} hr` : `${h} hr ${r} min`
}
