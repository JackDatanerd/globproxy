'use client'
import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

const ENDPOINTS = [
  { method:'GET', title:'Bandwidth balance', path:'/api/v1/account/bandwidth',
    example:`curl https://globproxy.com/api/v1/account/bandwidth \\\n  -H "Authorization: Bearer YOUR_KEY"` },
  { method:'POST', title:'Create sub-user', path:'/api/v1/sub-users',
    example:`curl -X POST https://globproxy.com/api/v1/sub-users \\\n  -H "Authorization: Bearer YOUR_KEY" \\\n  -d '{"label":"Client A","gb_allocated":5,"country":"US"}'` },
  { method:'GET', title:'Get usage stats', path:'/api/v1/sub-users/:id/usage',
    example:`curl https://globproxy.com/api/v1/sub-users/SUB_ID/usage \\\n  -H "Authorization: Bearer YOUR_KEY"` },
]

export default function ApiKeysPage() {
  const [key, setKey] = useState<string|null>(null)
  const [revealed, setRevealed] = useState(false)

  useEffect(() => {
    createClient().auth.getSession().then(({ data: { session } }) => {
      if (session?.access_token) setKey(session.access_token)
    })
  }, [])

  function copy(text: string) { navigator.clipboard.writeText(text); toast.success('Copied!') }

  return (
    <div className="max-w-3xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">API Keys</h1>
        <p className="text-muted text-sm mt-1">Automate sub-user creation, bandwidth allocation, and usage tracking.</p>
      </div>

      <div className="bg-white border border-border rounded-xl p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display font-bold text-base text-ink">Your API key</h2>
          <span className="text-[10px] font-mono bg-accent2-light text-accent2 px-2.5 py-1 rounded-full">Active</span>
        </div>
        <div className="bg-surface border border-border rounded-lg p-4 flex items-center gap-3 mb-4">
          <span className="font-mono text-xs text-ink flex-1 truncate">{revealed && key ? key : 'gp_••••••••••••••••••••••••••••••••'}</span>
          <button onClick={()=>setRevealed(!revealed)} className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors flex-shrink-0">{revealed?'Hide':'Reveal'}</button>
          <button onClick={()=>key&&copy(key)} className="text-xs font-mono text-accent border border-accent/30 px-2.5 py-1 rounded-lg transition-colors flex-shrink-0">Copy</button>
        </div>
        <p className="text-xs text-muted">Keep your API key private. Never expose it in client-side code.</p>
      </div>

      <div className="bg-white border border-border rounded-xl p-6">
        <h2 className="font-display font-bold text-base text-ink mb-5">Quick reference</h2>
        <div className="flex flex-col gap-4">
          {ENDPOINTS.map(ep=>(
            <div key={ep.title} className="border border-border rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-2.5 bg-surface border-b border-border">
                <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded ${ep.method==='GET'?'bg-accent-light text-accent':'bg-accent2-light text-accent2'}`}>{ep.method}</span>
                <span className="font-mono text-xs text-ink">{ep.path}</span>
                <span className="text-xs text-muted ml-auto">{ep.title}</span>
              </div>
              <pre className="px-4 py-3 text-xs font-mono text-ink2 overflow-x-auto bg-white">{ep.example}</pre>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
