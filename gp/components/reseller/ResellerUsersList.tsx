'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import clsx from 'clsx'

export default function ResellerUsersList({
  subUsers, availableGb, resellerId
}: { subUsers: any[]; availableGb: number; resellerId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ label: '', gb: 1, country: '', state: '', city: '', email: '' })

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (form.gb > availableGb) { toast.error('Not enough bandwidth in your stock'); return }
    setLoading(true)
    try {
      const sb = createClient()
      const { data: existing } = await sb.from('profiles').select('id').eq('email', form.email).single()
      if (!existing) {
        toast.error('User not found. They must sign up at globproxy.com first.')
        setLoading(false); return
      }

      // Deduct from reseller stock immediately
      const { data: resellerBw } = await sb
        .from('bandwidth_accounts').select('used_gb').eq('user_id', resellerId).single()
      await sb.from('bandwidth_accounts')
        .update({ used_gb: (resellerBw?.used_gb ?? 0) + form.gb })
        .eq('user_id', resellerId)

      // Credit GB to recipient immediately
      const { data: recipBw } = await sb
        .from('bandwidth_accounts').select('total_gb').eq('user_id', existing.id).single()
      await sb.from('bandwidth_accounts')
        .update({ total_gb: (recipBw?.total_gb ?? 0) + form.gb })
        .eq('user_id', existing.id)

      // Create proxy credential via API (calls Geonode)
      const { data: { session } } = await sb.auth.getSession()
      const res = await fetch('/api/reseller/allocate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({
          recipient_id: existing.id,
          label: form.label || `${form.email.split('@')[0]} allocation`,
          gb_allocated: form.gb,
          country: form.country || null,
          state: form.state || null,
          city: form.city || null,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      toast.success(`${form.gb}GB allocated and active for ${form.email}`)
      setOpen(false)
      setForm({ label: '', gb: 1, country: '', state: '', city: '', email: '' })
      window.location.reload()
    } catch (err: any) {
      toast.error(err.message)
    } finally { setLoading(false) }
  }

  return (
    <div>
      <div className="bg-white border border-border rounded-xl mb-5">
        <button onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between p-5 text-left">
          <div>
            <div className="font-medium text-ink text-sm">Allocate bandwidth to a client</div>
            <div className="text-xs text-muted mt-0.5">Activates immediately. Collect payment from your client first.</div>
          </div>
          <span className={`text-xl text-muted transition-transform ${open ? 'rotate-45' : ''}`}>+</span>
        </button>

        {open && (
          <form onSubmit={create} className="px-5 pb-5 border-t border-border pt-5">
            <div className="grid grid-cols-2 gap-4 mb-4">
              {[
                ['Client email *', 'email', 'email', 'client@example.com'],
                ['Session label', 'label', 'text', 'e.g. Client A'],
              ].map(([l, k, t, p]) => (
                <div key={k as string}>
                  <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">{l}</label>
                  <input required={k === 'email'} type={t as string} value={(form as any)[k as string]}
                    onChange={e => setForm({ ...form, [k as string]: e.target.value })} placeholder={p as string}
                    className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
                </div>
              ))}
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">GB to allocate *</label>
                <input required type="number" min={0.1} step={0.1} max={availableGb} value={form.gb}
                  onChange={e => setForm({ ...form, gb: +e.target.value })}
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
                <div className="text-[10px] font-mono text-muted mt-1">{availableGb.toFixed(2)} GB available</div>
              </div>
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Country</label>
                <input value={form.country} onChange={e => setForm({ ...form, country: e.target.value })}
                  placeholder="e.g. US, KE, GB"
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">State</label>
                <input value={form.state} onChange={e => setForm({ ...form, state: e.target.value })}
                  placeholder="e.g. california"
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">City</label>
                <input value={form.city} onChange={e => setForm({ ...form, city: e.target.value })}
                  placeholder="e.g. nairobi"
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
              </div>
            </div>

            <div className="bg-accent2-light border border-accent2/20 rounded-lg px-4 py-3 mb-4">
              <p className="text-xs text-accent2 font-mono">
                ✓ Bandwidth activates immediately and is irreversible. Collect payment from your client before allocating.
              </p>
            </div>

            <div className="flex gap-3">
              <button type="submit" disabled={loading}
                className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
                {loading ? 'Allocating...' : `Allocate ${form.gb}GB →`}
              </button>
              <button type="button" onClick={() => setOpen(false)}
                className="border border-border text-muted px-5 py-2.5 rounded-xl text-sm hover:text-ink transition-colors">
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {subUsers.length > 0 ? (
        <div className="flex flex-col gap-3">
          {subUsers.map(u => (
            <div key={u.id} className="bg-white border border-border rounded-xl p-5">
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="font-medium text-ink text-sm">{u.label || 'Unnamed'}</span>
                    <span className={clsx(
                      'text-[10px] font-mono px-2 py-0.5 rounded-full',
                      u.status === 'active' ? 'bg-accent2-light text-accent2' :
                      u.status === 'pending' ? 'bg-yellow-50 text-yellow-600' :
                      'bg-red-50 text-red-400'
                    )}>{u.status}</span>
                  </div>
                  <div className="text-xs text-muted">
                    {u.profiles?.email}
                    {u.country && ` · ${u.country}`}
                    {u.state && `/${u.state}`}
                    {u.city && `/${u.city}`}
                  </div>
                  {u.status === 'active' && u.geonode_username && (
                    <div className="mt-1.5 text-xs font-mono text-muted">{u.host}:{u.port} · {u.geonode_username}</div>
                  )}
                  {u.status === 'pending' && (
                    <div className="mt-2 text-xs font-mono text-yellow-600 bg-yellow-50 px-3 py-1.5 rounded-lg inline-block">
                      Provisioning credentials...
                    </div>
                  )}
                </div>
                <div className="text-right ml-4">
                  <div className="font-mono text-sm font-medium text-ink">{u.gb_allocated} GB</div>
                  <div className="text-xs text-muted">allocated</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl p-14 text-center">
          <p className="text-muted text-sm font-light">No sub-users yet. Allocate bandwidth to your first client above.</p>
        </div>
      )}
    </div>
  )
}
