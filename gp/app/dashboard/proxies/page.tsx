import { createClient, createAdminClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import ProxyList from '@/components/dashboard/ProxyList'
import { formatGb, formatPct } from '@/lib/format'
import { passwordRotationEnabled, toDashboardCredential, UPSTREAM_MISSING_GRACE_MS } from '@/lib/credentials'

export default async function ProxiesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  // Explicit columns, never '*': customers can read their whole row, and the
  // internal provisioning columns (last_provision_error, provision_attempts,
  // provisioning_claimed_at, upstream_sub_user_id…) have no business in the
  // browser payload. The supplier-named columns below are renamed server-side.
  // The proxy username/password are NOT selectable with the customer's own
  // session any more (column-level SELECT, migration 0059 — otherwise a
  // password-only session could read them straight from the REST API before
  // passing the MFA gate). This page is behind the MFA-gated middleware, so it
  // reads them server-side with the service role, scoped to the signed-in user.
  const admin = await createAdminClient()
  const [{ data: creds, error: credsError }, { data: bw, error: bwError }] = await Promise.all([
    admin.from('proxy_credentials')
      .select('id, user_id, created_by, label, status, gb_allocated, gb_used, country, state, city, asn, session_type, protocol, sticky_duration, endpoint_count, host, port, upstream_username, upstream_password, activated_at, created_at, auto_topup_enabled, auto_topup_threshold_gb, auto_topup_amount_gb, auto_topup_insufficient_alerted_at, pending_reason, provision_stalled_at, upstream_missing_since, suspended_reason')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    // maybeSingle: a brand-new account legitimately has no row (not an error);
    // a real failure is surfaced below instead of reading as "no bandwidth".
    supabase.from('bandwidth_accounts')
      .select('total_gb, used_gb, available_gb')
      .eq('user_id', user.id)
      .maybeSingle(),
  ])

  // A failed query used to fall through to the "No sessions yet" empty state,
  // inviting the customer to create a duplicate of a session that exists.
  if (credsError) {
    return (
      <div className="max-w-4xl">
        <h1 className="font-display font-bold text-2xl text-ink mb-4">My Proxies</h1>
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl px-5 py-4 text-sm">
          We couldn&apos;t load your sessions right now. Your proxies are unaffected — refresh the page to try again.
        </div>
      </div>
    )
  }

  // Never hand the browser the raw rows: their column names (and the
  // supplier's internal sub-user id) would show in the page payload. Expose
  // only neutral names.
  // toDashboardCredential also applies the supplier guard (see lib/credentials).
  // The "isn't responding" notice only after the same grace the admin alert waits for: the supplier's
  // listing can lag a just-created session by a few minutes, which is not an outage.
  const renderedAt = Date.now()
  const safeCreds = (creds ?? []).map((row: Record<string, any>) => toDashboardCredential(
    row.upstream_missing_since && renderedAt - Date.parse(row.upstream_missing_since) < UPSTREAM_MISSING_GRACE_MS
      ? { ...row, upstream_missing_since: null } : row))

  // The customer's own alert levels (Settings → E-mail notifications). Tolerant: if the columns
  // aren't there yet or the read fails, the original 80 / 95 apply.
  let warnPct = 80, urgentPct = 95
  try {
    const { data: lv } = await supabase.from('profiles').select('usage_warn_pct, usage_urgent_pct').eq('id', user.id).maybeSingle()
    const w = Number((lv as any)?.usage_warn_pct), u = Number((lv as any)?.usage_urgent_pct)
    if (Number.isFinite(w) && Number.isFinite(u) && w < u) { warnPct = w; urgentPct = u }
  } catch { /* defaults */ }

  const total     = bw?.total_gb     ?? 0
  const used      = bw?.used_gb      ?? 0
  const available = bw?.available_gb ?? 0
  const pct       = total > 0 ? (used / total) * 100 : 0

  return (
    <div className="max-w-4xl">
      {bwError && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          We couldn&apos;t load your bandwidth balance, so the figures below may be incomplete. Your bandwidth is unaffected — refresh to try again.
        </div>
      )}
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">My Proxies</h1>
          <p className="text-muted text-sm mt-1">
            {creds?.length ?? 0} session{creds?.length === 1 ? '' : 's'} · manage credentials, endpoints, and sticky sessions
          </p>
        </div>
        {available >= 0.01 ? (
          <Link href="/dashboard/proxies/new"
            className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:-translate-y-0.5 transition-all shadow-[0_2px_8px_rgba(0,87,255,.2)]">
            + New session
          </Link>
        ) : (
          <Link href="/dashboard/buy"
            className="bg-surface border border-border text-muted px-5 py-2.5 rounded-xl text-sm font-medium hover:text-ink transition-colors">
            Buy bandwidth first
          </Link>
        )}
      </div>

      {/* Bandwidth strip — condensed to one row so the list starts higher on
          the page; the full breakdown/CTA lives on the Overview page. */}
      {total > 0 && (
        <div className="bg-white border border-border rounded-xl px-5 py-4 mb-5 flex items-center gap-7 flex-wrap">
          {[
            ['Total', `${formatGb(total)} GB`, 'text-ink'],
            ['Used', `${formatGb(used)} GB`, 'text-amber-500'],
            ['Available', `${formatGb(available)} GB`, 'text-accent2'],
          ].map(([l, v, c]) => (
            <div key={l as string} className="flex-shrink-0">
              <div className="text-[9px] font-mono text-muted uppercase tracking-wider mb-0.5">{l}</div>
              <div className={`font-display font-bold text-base tracking-tight ${c}`}>{v}</div>
            </div>
          ))}
          <div className="flex-1 min-w-[160px]">
            <div className="bg-surface rounded-full h-[7px] overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-700 ${pct > 80 ? 'bg-red-400' : pct > 50 ? 'bg-amber-400' : 'bg-gradient-to-r from-accent to-sky-400'}`}
                style={{ width: `${Math.min(pct, 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-[10.5px] font-mono text-muted mt-1">
              <span>{formatPct(used, total)}% used</span>
              <span>{formatGb(available)} GB free to allocate</span>
            </div>
          </div>
          <div className="text-[10.5px] font-mono text-accent2 bg-accent2-light px-2.5 py-1 rounded-full flex-shrink-0">Never expires</div>
        </div>
      )}

      {/* No bandwidth state */}
      {total === 0 && !bwError && (
        <div className="bg-white border border-border rounded-xl p-12 text-center mb-6">
          <div className="text-3xl mb-3">⬡</div>
          <h2 className="font-display font-bold text-lg text-ink mb-2">No bandwidth yet</h2>
          <p className="text-muted text-sm font-light mb-5 max-w-xs mx-auto">
            Purchase bandwidth to start creating proxy sessions. Your GB never expires.
          </p>
          <Link href="/dashboard/buy"
            className="inline-flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
            Buy bandwidth →
          </Link>
        </div>
      )}

      {/* Proxy list */}
      {creds && creds.length > 0 ? (
        <ProxyList creds={safeCreds as unknown as React.ComponentProps<typeof ProxyList>["creds"]} availableGb={available} rotationEnabled={passwordRotationEnabled()} warnPct={warnPct} urgentPct={urgentPct} userId={user.id} />
      ) : total > 0 ? (
        <div className="bg-white border border-border rounded-xl p-12 text-center">
          <div className="text-3xl mb-3">⬡</div>
          <h2 className="font-display font-bold text-lg text-ink mb-2">No sessions yet</h2>
          <p className="text-muted text-sm font-light mb-5 max-w-xs mx-auto">
            {available >= 0.01
              ? `You have ${formatGb(available)} GB ready to use. Create your first proxy session.`
              : 'You have no unassigned bandwidth left. Buy more to create a session.'}
          </p>
          <Link href={available >= 0.01 ? '/dashboard/proxies/new' : '/dashboard/buy'}
            className="inline-flex items-center gap-2 bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
            {available >= 0.01 ? '+ New session →' : 'Buy bandwidth →'}
          </Link>
        </div>
      ) : null}
    </div>
  )
}
