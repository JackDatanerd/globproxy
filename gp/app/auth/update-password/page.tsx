'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

export default function UpdatePasswordPage() {
  const [pw, setPw] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handle(e: React.FormEvent) {
    e.preventDefault()
    if (pw !== confirm) { toast.error('Passwords do not match'); return }
    setLoading(true)
    const { error } = await createClient().auth.updateUser({ password: pw })
    if (error) { toast.error(error.message); setLoading(false); return }
    toast.success('Password updated!')
    router.push('/dashboard')
  }

  return (
    <div className="w-full max-w-md">
      <div className="bg-white border border-border rounded-2xl p-10 shadow-sm">
        <h1 className="font-display font-bold text-2xl text-ink mb-1">Set new password</h1>
        <p className="text-muted text-sm mb-8">Choose a strong password for your account.</p>
        <form onSubmit={handle} className="flex flex-col gap-5">
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">New password</label>
            <input type="password" required minLength={8} value={pw} onChange={e => setPw(e.target.value)} placeholder="Min. 8 characters"
              className="w-full bg-surface border border-border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
          </div>
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Confirm password</label>
            <input type="password" required value={confirm} onChange={e => setConfirm(e.target.value)} placeholder="Repeat new password"
              className={`w-full bg-surface border text-ink placeholder-muted px-4 py-3 rounded-xl text-sm focus:outline-none transition-colors ${confirm && pw !== confirm ? 'border-red-300' : 'border-border focus:border-accent'}`} />
            {confirm && pw !== confirm && <p className="text-xs text-red-500 mt-1.5">Passwords do not match</p>}
          </div>
          <button type="submit" disabled={loading || (!!confirm && pw !== confirm)}
            className="w-full bg-accent text-white py-3 rounded-xl font-medium text-sm hover:opacity-90 disabled:opacity-60 transition-opacity">
            {loading ? 'Updating...' : 'Update password →'}
          </button>
        </form>
      </div>
    </div>
  )
}
