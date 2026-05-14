'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

export default function SettingsPage() {
  const [profile, setProfile] = useState<any>(null)
  const [form, setForm] = useState({ full_name:'', company_name:'' })
  const [pw, setPw] = useState({ next:'', confirm:'' })
  const [loading, setLoading] = useState(false)
  
  // New states for the new APIs
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    const sb = createClient()
    sb.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await sb.from('profiles').select('*').eq('id',user.id).single()
      setProfile(data)
      setForm({ full_name: data?.full_name??'', company_name: data?.company_name??'' })
    })
  }, [])

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault(); setLoading(true)
    const { error } = await createClient().from('profiles').update(form).eq('id',profile.id)
    if (error) toast.error(error.message)
    else toast.success('Profile updated')
    setLoading(false)
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault()
    if (pw.next !== pw.confirm) { toast.error('Passwords do not match'); return }
    setLoading(true)
    const { error } = await createClient().auth.updateUser({ password: pw.next })
    if (error) toast.error(error.message)
    else { toast.success('Password updated'); setPw({ next:'', confirm:'' }) }
    setLoading(false)
  }

  // --- NEW: Reseller application API call ---
  async function applyReseller() {
    setApplying(true)
    try {
      const res = await fetch('/api/auth/apply-reseller', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to apply')
      
      toast.success('Application submitted for review!')
      setProfile({ ...profile, reseller_status: 'pending' })
    } catch (err: any) {
      toast.error(err.message)
    }
    setApplying(false)
  }

  // --- NEW: Delete Account API call ---
  async function deleteAccount() {
    if (!confirm('Are you absolutely sure you want to permanently delete your account? This cannot be undone.')) return;
    
    try {
        const res = await fetch('/api/user/delete-account', { method: 'DELETE' })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || 'Failed to delete account')
        
        toast.success('Account deleted successfully')
        // Force a full refresh to clear cached session data & redirect to login
        window.location.href = '/'
    } catch(err: any) {
        toast.error(err.message)
    }
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Settings</h1>
        <p className="text-muted text-sm mt-1">Manage your account details</p>
      </div>

      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-5">Profile</h2>
        <form onSubmit={saveProfile} className="flex flex-col gap-4">
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Email</label>
            <input value={profile?.email??''} disabled className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm text-muted cursor-not-allowed" />
          </div>
          {[['Full name','full_name','Your name'],['Company name','company_name','Your business name (optional)']].map(([l,k,p])=>(
            <div key={k}>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">{l}</label>
              <input value={(form as any)[k]} onChange={e=>setForm({...form,[k]:e.target.value})} placeholder={p}
                className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
            </div>
          ))}
          <button type="submit" disabled={loading} className="self-start bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
            {loading ? 'Saving...' : 'Save changes'}
          </button>
        </form>
      </div>

      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-5">Change password</h2>
        <form onSubmit={changePassword} className="flex flex-col gap-4">
          {[['New password','next','Min. 8 characters'],['Confirm password','confirm','Repeat new password']].map(([l,k,p])=>(
            <div key={k}>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">{l}</label>
              <input type="password" placeholder={p} value={(pw as any)[k]} onChange={e=>setPw({...pw,[k]:e.target.value})}
                className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
            </div>
          ))}
          <button type="submit" disabled={loading} className="self-start border border-border text-ink2 px-6 py-2.5 rounded-xl text-sm font-medium hover:border-ink2 hover:text-ink disabled:opacity-60 transition-all">
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>

      {/* NEW: Updated Reseller Section */}
      {profile?.role === 'user' && profile?.reseller_status !== 'pending' && (
        <div className="bg-accent2-light border border-accent2/20 rounded-xl p-6 mb-5">
          <h2 className="font-display font-bold text-base text-accent2 mb-2">Become a reseller</h2>
          <p className="text-sm text-ink2 font-light mb-4">Buy wholesale bandwidth and resell under your own brand. No minimum commitment.</p>
          <button 
            onClick={applyReseller} 
            disabled={applying}
            className="inline-flex items-center gap-2 bg-accent2 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity"
          >
            {applying ? 'Applying...' : 'Apply now →'}
          </button>
        </div>
      )}

      {profile?.reseller_status === 'pending' && (
         <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6 mb-5">
           <h2 className="font-display font-bold text-base text-yellow-800 mb-2">Application Pending</h2>
           <p className="text-sm text-yellow-700 font-light">Your reseller application is currently under review by our team.</p>
         </div>
      )}

      {/* NEW: Delete Account Section */}
      <div className="bg-red-50 border border-red-100 rounded-xl p-6">
        <h2 className="font-display font-bold text-base text-red-600 mb-2">Danger Zone</h2>
        <p className="text-sm text-red-500 font-light mb-4">Permanently delete your account and all associated data. This action is irreversible.</p>
        <button 
          onClick={deleteAccount}
          className="border border-red-200 bg-white text-red-600 px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-red-50 transition-colors"
        >
          Delete Account
        </button>
      </div>
    </div>
  )
}