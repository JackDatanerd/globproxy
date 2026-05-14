'use client'

import { useState, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import clsx from 'clsx'

export default function ResellerUsersList({
  subUsers, availableGb, resellerId
}: { subUsers: any[]; availableGb: number; resellerId: string }) {
  
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ email: '', gb: 1 })
  const [quickGbs, setQuickGbs] = useState<Record<string, string>>({})
  const [quickLoadings, setQuickLoadings] = useState<Record<string, boolean>>({})

  // Compute unique clients from the raw transfer history
  const uniqueClients = useMemo(() => {
    const map = new Map()
    for (const transfer of subUsers) {
       if (transfer.profiles) {
         const pid = transfer.recipient_id
         if (!map.has(pid)) {
           map.set(pid, {
              id: pid,
              email: transfer.profiles.email,
              total_received_gb: 0,
              last_transfer_date: null
           })
         }
         const client = map.get(pid)
         client.total_received_gb += (transfer.gb_amount || 0)
         
         const transferDate = new Date(transfer.created_at)
         if (!client.last_transfer_date || transferDate > new Date(client.last_transfer_date)) {
            client.last_transfer_date = transfer.created_at
         }
       }
    }
    return Array.from(map.values())
  }, [subUsers])

  async function handleAllocate(email: string, gb: number, recipientId?: string) {
    if (gb > availableGb) { toast.error('Not enough bandwidth in your stock'); return }
    
    const isQuick = !!recipientId;
    if (isQuick) setQuickLoadings(prev => ({...prev, [recipientId]: true}))
    else setLoading(true)

    try {
      const sb = createClient()
      const { data: { session } } = await sb.auth.getSession()
      
      const res = await fetch('/api/reseller/allocate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
        body: JSON.stringify({ recipient_email: email, gb_allocated: gb }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      toast.success(`${gb}GB successfully added to ${email}'s account`)
      
      if (!isQuick) {
        setOpen(false)
        setForm({ email: '', gb: 1 })
      }
      
      window.location.reload()
    } catch (err: any) {
      toast.error(err.message)
    } finally { 
      if (isQuick) setQuickLoadings(prev => ({...prev, [recipientId as string]: false}))
      else setLoading(false) 
    }
  }

  return (
    <div>
      {/* Primary Allocation Form */}
      <div className="bg-white border border-border rounded-xl mb-6 shadow-sm">
        <button onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between p-5 text-left transition-colors hover:bg-zinc-50 rounded-xl">
          <div>
            <div className="font-medium text-ink text-sm">Send bandwidth to a client</div>
            <div className="text-xs text-muted mt-0.5">Activates immediately. The balance will be deposited in their dashboard.</div>
          </div>
          <span className={`text-xl text-muted font-light transition-transform ${open ? 'rotate-45' : ''}`}>+</span>
        </button>

        {open && (
           <form onSubmit={(e) => { e.preventDefault(); handleAllocate(form.email, form.gb); }} className="px-5 pb-5 border-t border-border pt-5">
            <div className="grid grid-cols-2 gap-4 mb-5">
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Client Email *</label>
                <input required type="email" value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })} placeholder="client@example.com"
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
              </div>
              
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">GB to send *</label>
                <input required type="number" min={0.1} step={0.1} max={availableGb} value={form.gb}
                  onChange={e => setForm({ ...form, gb: +e.target.value })}
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent" />
                <div className="text-[10px] font-mono text-muted mt-1">{availableGb.toFixed(2)} GB available</div>
              </div>
            </div>

            <div className="flex gap-3">
              <button type="submit" disabled={loading}
                className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
                {loading ? 'Sending...' : `Send ${form.gb} GB →`}
              </button>
            </div>
           </form>
        )}
      </div>

      {/* Roster of active clients (from transfers instead of proxy sessions) */}
      <h3 className="text-sm font-display font-bold text-ink mb-3 pl-1">Your Clients</h3>
      {uniqueClients.length > 0 ? (
        <div className="flex flex-col gap-3">
          {uniqueClients.map(u => (
            <div key={u.id} className="bg-white border border-border rounded-xl p-5 flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm">
                <div>
                  <div className="font-medium text-ink text-sm mb-1">{u.email}</div>
                  <div className="text-[11px] text-muted">
                    Total transferred: <strong className="text-ink font-mono">{u.total_received_gb} GB</strong> 
                  </div>
                  <div className="text-[10px] text-muted tracking-wide mt-1 uppercase">
                    Last activity: {u.last_transfer_date ? new Date(u.last_transfer_date).toLocaleDateString() : 'N/A'}
                  </div>
                </div>

                {/* Quick Add Form specific to this recipient */}
                <div className="flex items-center gap-2 pt-2 md:pt-0 border-t md:border-t-0 border-border md:w-auto w-full">
                  <span className="text-[10px] font-mono text-muted uppercase mr-1 hidden md:block">Quick Top-Up</span>
                  <input
                    type="number"
                    min="0.1" step="0.1"
                    value={quickGbs[u.id] ?? '1'}
                    onChange={(e) => setQuickGbs(prev => ({...prev, [u.id]: e.target.value}))}
                    className="w-20 text-sm bg-surface border border-border rounded-lg px-2 py-2 focus:outline-none focus:border-accent"
                    placeholder="GB"
                  />
                  <button
                    onClick={() => handleAllocate(u.email, parseFloat(quickGbs[u.id] ?? '1') || 1, u.id)}
                    disabled={quickLoadings[u.id]}
                    className="bg-accent2 text-white px-4 py-2 rounded-lg text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity whitespace-nowrap"
                  >
                    {quickLoadings[u.id] ? 'Sending...' : 'Add +'}
                  </button>
                </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl p-14 text-center shadow-sm">
          <p className="text-muted text-sm font-light">No clients yet. Transfer bandwidth above to build your roster.</p>
        </div>
      )}
    </div>
  )
}