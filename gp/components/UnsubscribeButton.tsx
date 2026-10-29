'use client'
import { useState } from 'react'

export default function UnsubscribeButton({ u, t }: { u: string; t: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')

  async function go() {
    setState('busy')
    try {
      const res = await fetch(`/api/unsubscribe?u=${encodeURIComponent(u)}&t=${encodeURIComponent(t)}`, { method: 'POST' })
      setState(res.ok ? 'done' : 'error')
    } catch { setState('error') }
  }

  if (state === 'done') {
    return (
      <div className="bg-accent2-light border border-accent2/20 rounded-xl p-5 text-sm text-ink2">
        <p className="font-semibold text-ink mb-1">You&apos;re unsubscribed.</p>
        <p>You won&apos;t get product news or offers from us any more. Receipts and security notices will still reach you. You can turn this back on any time under Settings → E-mail notifications.</p>
      </div>
    )
  }
  return (
    <div>
      <button onClick={go} disabled={state === 'busy'}
        className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium disabled:opacity-60">
        {state === 'busy' ? 'Unsubscribing…' : 'Unsubscribe from product news & offers'}
      </button>
      {state === 'error' && <p className="text-sm text-red-600 mt-3">That didn&apos;t work. Please try again, or reply to any of our e-mails and we&apos;ll do it for you.</p>}
    </div>
  )
}
