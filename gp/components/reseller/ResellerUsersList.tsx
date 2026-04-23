'use client'
import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import clsx from 'clsx'

export default function ResellerUsersList({ subUsers, availableGb, resellerId }: { subUsers: any[]; availableGb: number; resellerId: string }) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ label:'', gb:1, country:'', email:'' })

  async function create(e: React.FormEvent) {
    e.preventDefault()
    if (form.gb > availableGb) { toast.error('Not enough bandwidth in your stock'); return }
    setLoading(true)
    try {
      const sb = createClient()
      const { data: existing } = await sb.from('profiles').select('id').eq('email',form.email).single()
      if (!existing) { toast.error('User not found. They must sign up at globproxy.com first.'); setLoading(false); return }

      const { data: cred, error } = await sb.from('proxy_credentials').insert({
        user_id: existing.id, created_by: resellerId, label: form.label,
        gb_allocated: form.gb, country: form.country||null, status:'pending',
      }).select().single()
      if (error) throw error

      await sb.from('reseller_transfers').insert({
        reseller_id: resellerId, recipient_id: existing.id,
        credential_id: cred.id, gb_amount: form.gb, status:'pending',
      })

      await sb.rpc('reserve_reseller_gb', { p_user_id: resellerId, p_gb: form.gb })

      toast.success(`${form.gb}GB allocated — activates when ${form.email} pays`)
      setOpen(false)
      setForm({ label:'', gb:1, country:'', email:'' })
      window.location.reload()
    } catch (err: any) { toast.error(err.message) }
    finally { setLoading(false) }
  }

  return (
    <div>
      <div className="bg-white border border-border rounded-xl mb-5">
        <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between p-5 text-left">
          <div>
            <div className="font-medium text-ink text-sm">Allocate bandwidth to a client</div>
            <div className="text-xs text-muted mt-0.5">Credentials activate when client pays GlobProxy</div>
          </div>
          <span className={`text-xl text-muted transition-transform ${open?'rotate-45':''}`}>+</span>
        </button>
        {open && (
          <form onSubmit={create} className="px-5 pb-5 border-t border-border pt-5">
            <div className="grid grid-cols-2 gap-4 mb-4">
              {[['Client email *','email','email','client@example.com'],['Session label','label','text','e.g. Client A - US']].map(([l,k,t,p])=>(
                <div key={k}>
                  <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">{l}</label>
                  <input required={k==='email'} type={t} value={(form as any)[k]} onChange={e=>setForm({...form,[k]:e.target.value})} placeholder={p}
                    className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
                </div>
              ))}
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">GB to allocate</label>
                <input required type="number" min={0.1} step={0.1} max={availableGb} value={form.gb} onChange={e=>setForm({...form,gb:+e.target.value})}
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
              </div>
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Country (optional)</label>
                <input value={form.country} onChange={e=>setForm({...form,country:e.target.value})} placeholder="e.g. US, UK, DE"
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
              </div>
            </div>
            <div className="bg-yellow-50 border border-yellow-100 rounded-lg px-4 py-3 mb-4">
              <p className="text-xs text-yellow-700 font-mono">⏳ GB reserved from your stock now. Credentials only activate when your client pays GlobProxy.</p>
            </div>
            <div className="flex gap-3">
              <button type="submit" disabled={loading} className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
                {loading ? 'Allocating...' : `Allocate ${form.gb}GB →`}
              </button>
              <button type="button" onClick={()=>setOpen(false)} className="border border-border text-muted px-5 py-2.5 rounded-xl text-sm hover:text-ink transition-colors">Cancel</button>
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
                    <span className="font-medium text-ink text-sm">{u.label||'Unnamed'}</span>
                    <span className={clsx('text-[10px] font-mono px-2 py-0.5 rounded-full',u.status==='active'?'bg-accent2-light text-accent2':u.status==='pending'?'bg-yellow-50 text-yellow-600':'bg-red-50 text-red-400')}>{u.status}</span>
                  </div>
                  <div className="text-xs text-muted">{u.profiles?.email}{u.country&&` · ${u.country}`}</div>
                  {u.status==='pending' && <div className="mt-2 text-xs font-mono text-yellow-600 bg-yellow-50 px-3 py-1.5 rounded-lg inline-block">Awaiting client payment</div>}
                  {u.status==='active' && u.geonode_username && <div className="mt-2 text-xs font-mono text-muted">{u.geonode_username} · {u.host}:{u.port}</div>}
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
