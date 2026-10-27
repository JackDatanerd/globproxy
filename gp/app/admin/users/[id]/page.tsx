import AdminPaymentHold from '@/components/admin/AdminPaymentHold'
import { suspendedReasonLabel } from '@/lib/suspendReason'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import AdminSyncUsageButton from '@/components/admin/AdminSyncUsageButton'
import AdminMfaResetButton from '@/components/admin/AdminMfaResetButton'
import AdminDeleteUserButton from '@/components/admin/AdminDeleteUserButton'
import AdminDeletionPanel from '@/components/admin/AdminDeletionPanel'
import AdminUserControls from '@/components/admin/AdminUserControls'
import AdminCredentialAction from '@/components/admin/AdminCredentialAction'
import AdminUserSecurityPanel, { type PanelSession, type PanelKey } from '@/components/admin/AdminUserSecurityPanel'
import { formatGb } from '@/lib/format'
import { formatRatePct, DEFAULT_AFFILIATE_INTRO_RATE, DEFAULT_AFFILIATE_LIFETIME_RATE } from '@/lib/rates'

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createAdminClient()

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single()

  if (!profile) notFound()
  // A deleted account stays viewable (its orders and the admin history are
  // still the record) but gets no controls.
  const deleted = !!profile.is_deleted
  const { data: hold } = await supabase.from('payment_holds').select('reason, source, created_at').eq('user_id', id).maybeSingle()

  const CRED_LIMIT = 100
  const [{ data: bw }, { data: creds, count: credCount, error: credErr }, { data: audit }, { data: orders, error: ordersErr }, { data: adjustments }, { data: secEvents }, { data: apiKeys }, { data: referralStats }, { data: payouts }, sessionsRes] = await Promise.all([
    supabase.from('bandwidth_accounts')
      .select('total_gb, used_gb, allocated_gb, available_gb')
      .eq('user_id', id)
      .single(),
    // Only the columns shown, newest first, capped: a reseller can hold thousands of
    // sub-user credentials (select('*') silently stopped at 1000 rows, made the
    // "Credentials (N)" heading wrong and shipped every column of every row).
    supabase.from('proxy_credentials')
      .select('id, label, city, state, country, gb_allocated, gb_used, status, suspended_reason, created_at', { count: 'exact' })
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(CRED_LIMIT),
    // Everything an admin has done to this account (admin_audit_log, migration 0043).
    supabase.from('admin_audit_log')
      .select('id, action, details, created_at, admin:admin_id(email)')
      .eq('target_user_id', id)
      .order('created_at', { ascending: false })
      .limit(15),
    supabase.from('orders')
      .select('id, created_at, gb_amount, amount_usd, refunded_usd, payment_status, invoice_number, dispute_status, is_canary')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase.from('bandwidth_adjustments')
      .select('id, gb_delta, reason, created_at, admin:admin_id(email)')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase.from('security_events')
      .select('id, event, ip, created_at, actor_id')
      .eq('user_id', id)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase.from('api_keys')
      .select('id, label, key_prefix, created_at, last_used_at, last_used_ip, expires_at')
      .eq('user_id', id)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .limit(50),
    // Referrals this account has made (as an affiliate / referrer).
    supabase.from('referrals')
      .select('id, flagged')
      .eq('referrer_id', id),
    supabase.from('affiliate_payouts')
      .select('id, amount_usd, status, cycle_start, cycle_end, paid_at')
      .eq('referrer_id', id)
      .order('cycle_start', { ascending: false })
      .limit(5),
    supabase.rpc('list_auth_sessions', { p_user_id: id }),
  ])
  // Their support reports, newest first — support used to be a separate inbox you could not
  // reach from the customer it was about.
  const { data: reports, count: reportCount } = await supabase.from('support_reports')
    .select('id, status, message, created_at', { count: 'exact' })
    .eq('user_id', id).order('created_at', { ascending: false }).limit(5)
  const activeKeys = apiKeys?.length ?? 0
  const sessionList: PanelSession[] = Array.isArray(sessionsRes?.data) ? sessionsRes.data : []
  const isAffiliate = !!profile.affiliate_status
  const referralCount = referralStats?.length ?? 0
  const flaggedCount = (referralStats ?? []).filter((r: any) => r.flagged).length

  const stats = [
    ['Total purchased', bw?.total_gb ?? 0, 'text-ink'],
    ['Used', bw?.used_gb ?? 0, 'text-amber-500'],
    ['Allocated (reserved)', bw?.allocated_gb ?? 0, 'text-accent'],
    ['Available', bw?.available_gb ?? 0, 'text-accent2'],
  ] as const

  return (
    <div className="max-w-6xl">
      <Link href="/admin/users" className="text-xs font-mono text-muted hover:text-ink transition-colors">
        ← All users
      </Link>

      {deleted && (
        <div className="mt-4 bg-surface border border-border text-ink2 text-sm rounded-xl px-4 py-3">
          <span className="font-medium">Deleted account</span>
          {profile.deleted_at && <span className="font-mono text-xs"> · {new Date(profile.deleted_at).toLocaleString('en-GB')}</span>}
          <span className="text-muted"> — personal data removed; orders and the admin history below are kept for accounting. No actions are available.</span>
        </div>
      )}

      {!deleted && profile.is_suspended && (
        <div className="mt-4 bg-red-50 border border-red-200 text-red-600 text-sm rounded-xl px-4 py-3">
          <span className="font-medium">Suspended</span>
          {profile.suspended_at && <span className="font-mono text-xs"> · {new Date(profile.suspended_at).toLocaleString('en-GB')}</span>}
          {profile.suspension_reason && <span> — {profile.suspension_reason}</span>}
        </div>
      )}

      {!deleted && hold && <AdminPaymentHold userId={id} hold={hold} />}

      <div className="mt-4 mb-8 flex items-start justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">{profile.full_name || profile.email}</h1>
          <p className="text-muted text-sm mt-1 font-mono">{profile.email}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${profile.mfa_enabled ? 'bg-accent2-light text-accent2' : 'bg-amber-50 text-amber-700'}`}>
              2FA {profile.mfa_enabled ? 'ENABLED' : 'NOT ENABLED'}
            </span>
          </div>
        </div>
        {!deleted && <div className="flex items-center gap-2">
          <AdminUserControls user={{ id: profile.id, email: profile.email, role: profile.role, is_suspended: profile.is_suspended, api_access: profile.api_access, mfa_enabled: profile.mfa_enabled }} />
          {profile.mfa_enabled && profile.role !== 'admin' && <AdminMfaResetButton userId={id} />}
          <AdminSyncUsageButton userId={id} label="Sync this user's usage now" />
          {!hold && <AdminPaymentHold userId={id} hold={null} />}
          {/* Mirrors delete-user's own server-side check — hidden here too
              so the only way to hit "Cannot delete an admin account" is by
              editing the request by hand, not by a normal click. */}
          {profile.role !== 'admin' && <AdminDeleteUserButton userId={id} email={profile.email} />}
        </div>}
      </div>

      <AdminDeletionPanel userId={id} state={{
        is_deleted: !!profile.is_deleted,
        deletion_requested_at: profile.deletion_requested_at ?? null,
        deletion_scheduled_at: profile.deletion_scheduled_at ?? null,
        deletion_attempts: profile.deletion_attempts ?? null,
        deletion_last_error: profile.deletion_last_error ?? null,
        deletion_last_attempt_at: profile.deletion_last_attempt_at ?? null,
        deletion_cleanup_pending: profile.deletion_cleanup_pending ?? null,
        deletion_cleanup_notes: profile.deletion_cleanup_notes ?? null,
      }} />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {stats.map(([label, value, color]) => (
          <div key={label} className="bg-white border border-border rounded-xl p-4">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">{label}</div>
            <div className={`font-display text-xl font-bold ${color}`}>{formatGb(Number(value))} GB</div>
          </div>
        ))}
      </div>

      {(credErr || ordersErr) && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl px-4 py-3">
          Couldn&apos;t load {[credErr && 'credentials', ordersErr && 'orders'].filter(Boolean).join(' and ')} — what&apos;s shown below may be incomplete. Reload to retry.
        </div>
      )}

      <div className="mb-4">
        <h2 className="font-display font-bold text-sm text-ink">Credentials ({credCount ?? creds?.length ?? 0})</h2>
        {(credCount ?? 0) > CRED_LIMIT && (
          <p className="text-xs text-amber-700 mt-1">
            Showing the newest {CRED_LIMIT}. <Link href={`/admin/credentials?q=${encodeURIComponent(profile.email ?? '')}`} className="underline">See all {credCount} in Credentials →</Link>
          </p>
        )}
        <p className="text-muted text-xs mt-1">
          &quot;Used&quot; only reflects currently-active credentials — usage from a deleted credential
          no longer shows here (the GB it consumed stays permanently subtracted from Available above,
          it just isn&apos;t broken out by credential anymore).
        </p>
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface">
              {['Label', 'Location', 'Allocated', 'Used', 'Status', 'Created', 'Action'].map(h => (
                <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(creds ?? []).length === 0 ? (
              <tr>
                <td colSpan={7} className="px-5 py-12 text-center text-sm text-muted">
                  No credentials yet.
                </td>
              </tr>
            ) : (creds ?? []).map((c, i) => (
              <tr key={c.id} className={`${i < (creds?.length ?? 0) - 1 ? 'border-b border-border' : ''} hover:bg-surface`}>
                <td className="px-5 py-3 text-sm text-ink">{c.label || '—'}</td>
                <td className="px-5 py-3 text-xs font-mono text-muted">
                  {[c.city, c.state, c.country].filter(Boolean).join(', ') || 'Any'}
                </td>
                <td className="px-5 py-3 font-mono text-sm text-ink">{formatGb(c.gb_allocated)}</td>
                <td className="px-5 py-3 font-mono text-sm text-ink">
                  {formatGb(c.gb_used)}
                  {c.status !== 'active' && <span className="text-muted text-xs ml-1">(last known)</span>}
                </td>
                <td className="px-5 py-3">
                  <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
                    c.status === 'active' ? 'bg-accent2-light text-accent2' :
                    c.status === 'pending' ? 'bg-yellow-50 text-yellow-600' :
                    'bg-red-50 text-red-400'
                  }`}>{c.status}</span>
                  {c.status === 'suspended' && c.suspended_reason && (
                    <div className="text-[10px] font-mono text-muted mt-1">
                      {suspendedReasonLabel(c.suspended_reason)}
                    </div>
                  )}
                </td>
                <td className="px-5 py-3 text-xs font-mono text-muted">
                  {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                </td>
                <td className="px-5 py-3">{!deleted && (c.suspended_reason === 'customer' ? <span className="text-[10px] font-mono text-muted">only the customer can resume</span> : <AdminCredentialAction credentialId={c.id} status={c.status} />)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>


      {/* Orders */}
      <div className="bg-white border border-border rounded-xl overflow-hidden mt-6">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-display font-bold text-base text-ink">Recent orders</h2>
          <Link href={`/admin/orders?q=${encodeURIComponent(profile.email ?? '')}`} className="text-xs font-mono text-accent hover:underline">All orders →</Link>
        </div>
        {(orders ?? []).length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-muted">No orders.</div>
        ) : (
          <table className="w-full">
            <tbody>
              {(orders ?? []).map((o: any, i: number) => (
                <tr key={o.id} className={i < (orders?.length ?? 0) - 1 ? 'border-b border-border' : ''}>
                  <td className="px-6 py-3 text-xs font-mono text-muted whitespace-nowrap">{new Date(o.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</td>
                  <td className="px-6 py-3 font-mono text-sm text-ink">{o.gb_amount} GB</td>
                  <td className="px-6 py-3 font-mono text-sm text-ink">${Number(o.amount_usd).toFixed(2)}{Number(o.refunded_usd ?? 0) > 0 && <span className="text-red-500 text-xs ml-1">−${Number(o.refunded_usd).toFixed(2)}</span>}</td>
                  <td className="px-6 py-3 text-xs font-mono text-muted">
                    {o.payment_status}{o.is_canary ? ' · canary' : ''}{o.dispute_status === 'open' ? ' · ⚠ dispute' : ''}
                  </td>
                  <td className="px-6 py-3 text-xs font-mono text-muted">{o.invoice_number ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Affiliate / Verified Operator */}
      {(isAffiliate || referralCount > 0) && (
        <div className="bg-white border border-border rounded-xl p-6 mt-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-display font-bold text-base text-ink">
              Affiliate
              {profile.is_verified_operator && <span className="ml-2 text-[10px] font-mono bg-accent2/10 text-accent2 px-2 py-0.5 rounded-full">✓ Verified Operator</span>}
            </h2>
            {isAffiliate && <Link href={`/admin/affiliates/${id}`} className="text-xs font-mono text-accent hover:underline">Affiliate details →</Link>}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <div><div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Status</div><div className="font-mono text-ink">{profile.affiliate_status ?? 'not an affiliate'}</div></div>
            <div><div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Rates (intro / lifetime)</div><div className="font-mono text-ink">{isAffiliate ? `${formatRatePct(profile.affiliate_commission_rate ?? DEFAULT_AFFILIATE_INTRO_RATE)} / ${formatRatePct(profile.affiliate_commission_rate_lifetime ?? DEFAULT_AFFILIATE_LIFETIME_RATE)}` : '—'}</div></div>
            <div><div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Referrals</div><div className="font-mono text-ink">{referralCount}{flaggedCount > 0 && <span className="text-amber-700"> ({flaggedCount} flagged)</span>}</div></div>
            <div><div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">Verified since</div><div className="font-mono text-ink">{profile.verified_operator_since ? new Date(profile.verified_operator_since).toLocaleDateString('en-GB') : '—'}</div></div>
          </div>
          {(payouts ?? []).length > 0 && (
            <div className="mt-4 border-t border-border pt-3">
              <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-2">Recent payouts</div>
              {(payouts ?? []).map((p: any) => (
                <div key={p.id} className="flex justify-between text-xs font-mono py-0.5">
                  <span className="text-muted">{p.cycle_start} → {p.cycle_end}</span>
                  <span className="text-ink">${Number(p.amount_usd).toFixed(2)} · {p.status}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Manual bandwidth adjustments */}
      {(adjustments ?? []).length > 0 && (
        <div className="bg-white border border-border rounded-xl overflow-hidden mt-6">
          <div className="px-6 py-4 border-b border-border"><h2 className="font-display font-bold text-base text-ink">Manual bandwidth adjustments</h2></div>
          <ul>
            {(adjustments ?? []).map((a: any, i: number) => (
              <li key={a.id} className={`px-6 py-3 flex items-start justify-between gap-4 ${i < (adjustments?.length ?? 0) - 1 ? 'border-b border-border' : ''}`}>
                <div>
                  <div className={`text-sm font-mono ${Number(a.gb_delta) > 0 ? 'text-accent2' : 'text-red-500'}`}>{Number(a.gb_delta) > 0 ? '+' : ''}{Number(a.gb_delta).toFixed(2)} GB</div>
                  <div className="text-[11px] text-muted mt-0.5">{a.reason}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-mono text-muted">{new Date(a.created_at).toLocaleString('en-GB')}</div>
                  <div className="text-[11px] text-muted">{a.admin?.email ?? 'system'}</div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <AdminUserSecurityPanel
        userId={id} email={profile.email ?? ''} canAct={!deleted && profile.role !== 'admin'}
        sessions={sessionList.map((x: any) => ({ id: String(x.id), created_at: x.created_at ?? null, updated_at: x.updated_at ?? null, user_agent: x.user_agent ?? null, ip: x.ip ? String(x.ip) : null }))}
        keys={(apiKeys ?? []) as PanelKey[]} sessionsError={!!sessionsRes?.error}
      />

      <div className="bg-white border border-border rounded-xl overflow-hidden mt-6">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-display font-bold text-base text-ink">Support reports ({reportCount ?? 0})</h2>
          {(reportCount ?? 0) > 0 && <Link href={`/admin/support?user=${id}&status=${(reports ?? []).some((r: any) => r.status === 'open') ? 'open' : 'resolved'}`} className="text-xs font-mono text-accent hover:underline">Open in support →</Link>}
        </div>
        {(reports ?? []).length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-muted">No reports from this customer.</div>
        ) : (
          <ul>
            {(reports ?? []).map((r: any, i: number) => (
              <li key={r.id} className={`px-6 py-3 flex items-start justify-between gap-4 ${i < (reports?.length ?? 0) - 1 ? 'border-b border-border' : ''}`}>
                <div className="text-sm text-ink min-w-0 break-words">{String(r.message ?? '').slice(0, 160)}{String(r.message ?? '').length > 160 ? '…' : ''}</div>
                <div className="text-right shrink-0">
                  <div className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${r.status === 'open' ? 'bg-amber-50 text-amber-700' : 'bg-surface text-muted border border-border'}`}>{r.status}</div>
                  <div className="text-[11px] font-mono text-muted mt-0.5">{new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Security events */}
      <div className="bg-white border border-border rounded-xl overflow-hidden mt-6">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-display font-bold text-base text-ink">Security events</h2>
          <span className="text-xs font-mono text-muted">{activeKeys} active API key{activeKeys === 1 ? '' : 's'}</span>
        </div>
        {(secEvents ?? []).length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-muted">Nothing recorded.</div>
        ) : (
          <ul>
            {(secEvents ?? []).map((e: any, i: number) => (
              <li key={e.id} className={`px-6 py-3 flex items-center justify-between gap-4 ${i < (secEvents?.length ?? 0) - 1 ? 'border-b border-border' : ''}`}>
                <div className="text-sm font-mono text-ink">{e.event}{e.actor_id && e.actor_id !== id ? <span className="text-muted text-xs"> · by an admin</span> : ''}</div>
                <div className="text-right text-xs font-mono text-muted">{new Date(e.created_at).toLocaleString('en-GB')}{e.ip ? ` · ${e.ip}` : ''}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="bg-white border border-border rounded-xl overflow-hidden mt-6">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="font-display font-bold text-base text-ink">Admin activity on this account</h2>
          <Link href={`/admin/audit?user=${id}`} className="text-xs font-mono text-accent hover:underline">View all →</Link>
        </div>
        {(audit ?? []).length === 0 ? (
          <div className="px-6 py-8 text-center text-sm text-muted">Nothing recorded yet.</div>
        ) : (
          <ul>
            {(audit ?? []).map((a: any, i: number) => (
              <li key={a.id} className={`px-6 py-3 flex items-start justify-between gap-4 ${i < (audit?.length ?? 0) - 1 ? 'border-b border-border' : ''}`}>
                <div>
                  <div className="text-sm font-mono text-ink">{a.action}</div>
                  {a.details && Object.keys(a.details).length > 0 && (
                    <div className="text-[11px] font-mono text-muted mt-0.5 break-all">{JSON.stringify(a.details)}</div>
                  )}
                </div>
                <div className="text-right shrink-0">
                  <div className="text-xs font-mono text-muted">{new Date(a.created_at).toLocaleString('en-GB')}</div>
                  <div className="text-[11px] text-muted">{a.admin?.email ?? 'system'}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
