'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import clsx from 'clsx'

const COUNTRIES = [
  {code:'US',name:'United States'},{code:'GB',name:'United Kingdom'},{code:'DE',name:'Germany'},
  {code:'FR',name:'France'},{code:'CA',name:'Canada'},{code:'AU',name:'Australia'},
  {code:'SG',name:'Singapore'},{code:'JP',name:'Japan'},{code:'BR',name:'Brazil'},
  {code:'IN',name:'India'},{code:'NL',name:'Netherlands'},{code:'KE',name:'Kenya'},
  {code:'ZA',name:'South Africa'},{code:'NG',name:'Nigeria'},{code:'AE',name:'UAE'},
]

export default function NewProxyPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ label:'', gb_allocated:1, country:'US', city:'', session_type:'rotating' })

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    try {
      const { data: { session } } = await createClient().auth.getSession()
      const res = await fetch('/api/v1/sub-users', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${session?.access_token}` },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      toast.success('Proxy session created!')
      router.push('/dashboard/proxies')
    } catch (err: any) {
      toast.error(err.message)
    } finally { setLoading(false) }
  }

  return (
    <div className="max-w-xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">New proxy session</h1>
        <p className="text-muted text-sm mt-1">Configure a proxy session from your bandwidth balance.</p>
      </div>
      <form onSubmit={handle} className="bg-white border border-border rounded-xl p-6 flex flex-col gap-5">
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Session label</label>
          <input value={form.label} onChange={e => setForm({...form,label:e.target.value})} placeholder="e.g. US Scraper, UK Account"
            className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
        </div>
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">GB to allocate</label>
          <input type="number" required min={0.1} step={0.1} value={form.gb_allocated} onChange={e => setForm({...form,gb_allocated:+e.target.value})}
            className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
          <p className="text-xs text-muted mt-1">Minimum 0.1 GB (100 MB)</p>
        </div>
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Country</label>
          <select value={form.country} onChange={e => setForm({...form,country:e.target.value})}
            className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors">
            {COUNTRIES.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">City (optional)</label>
          <input value={form.city} onChange={e => setForm({...form,city:e.target.value})} placeholder="e.g. New York, London"
            className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
        </div>
        <div>
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-2">Session type</label>
          <div className="flex gap-3">
            {[{id:'rotating',label:'Rotating',desc:'New IP per request'},{id:'sticky',label:'Sticky',desc:'Same IP per session'}].map(t => (
              <button type="button" key={t.id} onClick={() => setForm({...form,session_type:t.id})}
                className={clsx('flex-1 p-4 rounded-xl border-2 text-left transition-all', form.session_type===t.id?'border-accent bg-accent-light':'border-border hover:border-accent/40')}>
                <div className="font-medium text-sm text-ink">{t.label}</div>
                <div className="text-xs text-muted mt-0.5">{t.desc}</div>
              </button>
            ))}
          </div>
        </div>
        <div className="h-px bg-border" />
        <div className="flex gap-3">
          <button type="submit" disabled={loading} className="flex-1 bg-accent text-white py-3 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
            {loading ? 'Creating...' : `Create session (${form.gb_allocated} GB) →`}
          </button>
          <button type="button" onClick={() => router.back()} className="border border-border text-muted px-5 py-3 rounded-xl text-sm hover:text-ink transition-colors">Cancel</button>
        </div>
      </form>
    </div>
  )
}
