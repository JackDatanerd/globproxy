'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { apiJson } from '@/lib/clientApi'

export default function AffiliateApplyForm() {
  const [channel, setChannel] = useState('')
  const [audience, setAudience] = useState('')
  const [plan, setPlan] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    if (!channel.trim() || !audience.trim() || !plan.trim()) {
      toast.error('All fields are required')
      return
    }
    setLoading(true)
    try {
      await apiJson('POST', '/api/auth/apply-affiliate', { channel: channel.trim(), audience: audience.trim(), plan: plan.trim() })
      setSubmitted(true)
    } catch (err: any) {
      toast.error(err.message ?? 'Application failed')
    } finally {
      setLoading(false)
    }
  }

  if (submitted) {
    return (
      <div className="bg-white border border-border rounded-xl p-5">
        <div className="text-sm font-medium text-ink mb-1">Application submitted</div>
        <div className="text-xs text-muted">We'll review it and follow up by email.</div>
      </div>
    )
  }

  return (
    <form onSubmit={handle} className="bg-white border border-border rounded-xl p-5 flex flex-col gap-3">
      <div>
        <div className="text-sm font-medium text-ink mb-1">Apply for the affiliate program</div>
        <div className="text-xs text-muted">
          Approved affiliates earn a cash commission on every order their referrals make — not just the first.
        </div>
      </div>
      <div>
        <label className="text-[10px] font-mono text-muted uppercase tracking-wider">Where do you promote?</label>
        <input
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          maxLength={120}
          placeholder="e.g. BlackHatWorld, a blog, a Discord server"
          className="w-full mt-1 text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2"
        />
      </div>
      <div>
        <label className="text-[10px] font-mono text-muted uppercase tracking-wider">Audience size / description</label>
        <input
          value={audience}
          onChange={(e) => setAudience(e.target.value)}
          maxLength={600}
          placeholder="e.g. ~5k forum followers, mostly scrapers"
          className="w-full mt-1 text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2"
        />
      </div>
      <div>
        <label className="text-[10px] font-mono text-muted uppercase tracking-wider">How will you promote GlobProxy?</label>
        <textarea
          value={plan}
          onChange={(e) => setPlan(e.target.value)}
          maxLength={1200}
          rows={3}
          placeholder="A couple sentences is enough"
          className="w-full mt-1 text-sm text-ink bg-surface border border-border rounded-lg px-3 py-2"
        />
      </div>
      <button
        type="submit"
        disabled={loading}
        className="text-xs font-mono px-4 py-2 rounded-lg border border-accent2 bg-accent2 text-white hover:opacity-90 transition-all disabled:opacity-50 self-start"
      >
        {loading ? 'Submitting…' : 'Submit application'}
      </button>
    </form>
  )
}
