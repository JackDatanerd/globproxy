import Link from 'next/link'
import { notFound } from 'next/navigation'
import { createAdminClient } from '@/lib/supabase/server'
import AdminSyncUsageButton from '@/components/admin/AdminSyncUsageButton'
import AdminMfaResetButton from '@/components/admin/AdminMfaResetButton'
import { formatGb } from '@/lib/format'

export default async function AdminUserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const supabase = await createAdminClient()

  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .eq('is_deleted', false)
    .single()

  if (!profile) notFound()

  const [{ data: bw }, { data: creds }] = await Promise.all([
    supabase.from('bandwidth_accounts')
      .select('total_gb, used_gb, allocated_gb, available_gb')
      .eq('user_id', id)
      .single(),
    supabase.from('proxy_credentials')
      .select('*')
      .eq('user_id', id)
      .order('created_at', { ascending: false }),
  ])

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

      <div className="mt-4 mb-8 flex items-start justify-between">
        <div>
          <h1 className="font-display font-bold text-2xl text-ink">{profile.full_name || profile.email}</h1>
          <p className="text-muted text-sm mt-1 font-mono">{profile.email}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${profile.mfa_enabled ? 'bg-accent2-light text-accent2' : 'bg-red-50 text-red-500'}`}>
              2FA {profile.mfa_enabled ? 'ENABLED' : 'NOT ENABLED'}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {profile.mfa_enabled && <AdminMfaResetButton userId={id} />}
          <AdminSyncUsageButton userId={id} label="Sync this user's usage now" />
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {stats.map(([label, value, color]) => (
          <div key={label} className="bg-white border border-border rounded-xl p-4">
            <div className="text-[10px] font-mono text-muted uppercase tracking-widest mb-1">{label}</div>
            <div className={`font-display text-xl font-bold ${color}`}>{formatGb(Number(value))} GB</div>
          </div>
        ))}
      </div>

      <div className="mb-4">
        <h2 className="font-display font-bold text-sm text-ink">Credentials ({creds?.length ?? 0})</h2>
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
              {['Label', 'Location', 'Allocated', 'Used', 'Status', 'Created'].map(h => (
                <th key={h} className="text-left px-5 py-3 text-[10px] font-mono text-muted uppercase tracking-widest">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(creds ?? []).length === 0 ? (
              <tr>
                <td colSpan={6} className="px-5 py-12 text-center text-sm text-muted">
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
                </td>
                <td className="px-5 py-3 text-xs font-mono text-muted">
                  {new Date(c.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
