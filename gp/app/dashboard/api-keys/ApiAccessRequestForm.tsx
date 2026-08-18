'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'

type Status = 'pending' | 'approved' | 'rejected' | null

export default function ApiAccessRequestForm({ status: initialStatus }: { status: Status }) {
  const [status, setStatus] = useState(initialStatus)
  const [useCase, setUseCase] = useState('')
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (useCase.trim().length < 10) {
      toast.error("Tell us a little about what you plan to automate (at least a sentence).")
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/dashboard/apply-api-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ use_case: useCase.trim(), website_url: websiteUrl.trim() || null }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to submit request')
      toast.success("Request submitted! We'll review and get back to you.")
      setStatus('pending')
    } catch (err: any) {
      toast.error(err.message)
    }
    setSubmitting(false)
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">API Access</h1>
        <p className="text-muted text-sm mt-1">
          Automate sub-user creation, bandwidth allocation, and usage tracking. See the{' '}
          <a href="/docs/api" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">full API docs →</a>
        </p>
      </div>

      {status === 'pending' ? (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6">
          <h2 className="font-display font-bold text-base text-yellow-800 mb-2">Request under review</h2>
          <p className="text-sm text-yellow-700 font-light">
            We've received your API access request and will be in touch shortly.
          </p>
        </div>
      ) : (
        <div className="bg-white border border-border rounded-xl p-8">
          {status === 'rejected' && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-5">
              Your previous request wasn't approved. You're welcome to apply again below —
              a bit more detail on what you're automating helps us review faster.
            </p>
          )}
          <h2 className="font-display font-bold text-lg text-ink mb-2">Request API access</h2>
          <p className="text-muted text-sm font-light mb-6 leading-relaxed">
            API access lets you create and manage sub-user proxy credentials for your own clients
            programmatically, instead of through the dashboard. It's granted per-reseller after a
            quick review.
          </p>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">
                What are you planning to automate? *
              </label>
              <textarea
                value={useCase}
                onChange={e => setUseCase(e.target.value)}
                placeholder="e.g. Auto-provisioning a proxy credential for each new client that signs up on our own platform"
                rows={4}
                required
                className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors resize-none"
              />
            </div>
            <div>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">
                Website (optional)
              </label>
              <input
                type="text"
                value={websiteUrl}
                onChange={e => setWebsiteUrl(e.target.value)}
                placeholder="https://yourcompany.com"
                className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors"
              />
            </div>
            <button type="submit" disabled={submitting}
              className="self-start bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
              {submitting ? 'Submitting...' : 'Submit request →'}
            </button>
          </form>
        </div>
      )}
    </div>
  )
}
