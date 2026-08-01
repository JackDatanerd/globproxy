'use client'
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'

const COUNTRIES = [
  'Afghanistan','Albania','Algeria','Angola','Argentina','Australia','Austria','Bangladesh',
  'Belgium','Bolivia','Brazil','Bulgaria','Cambodia','Cameroon','Canada','Chile','China',
  'Colombia','Croatia','Czech Republic','Denmark','Ecuador','Egypt','Estonia','Ethiopia',
  'Finland','France','Germany','Ghana','Greece','Guatemala','Hungary','India','Indonesia',
  'Iran','Iraq','Ireland','Israel','Italy','Ivory Coast','Japan','Jordan','Kazakhstan',
  'Kenya','Kuwait','Latvia','Lithuania','Malaysia','Mexico','Morocco','Mozambique',
  'Netherlands','New Zealand','Nigeria','Norway','Pakistan','Peru','Philippines','Poland',
  'Portugal','Qatar','Romania','Russia','Saudi Arabia','Senegal','Serbia','Singapore',
  'Slovakia','Slovenia','South Africa','South Korea','Spain','Sri Lanka','Sweden',
  'Switzerland','Taiwan','Tanzania','Thailand','Turkey','Uganda','Ukraine','United Arab Emirates',
  'United Kingdom','United States','Uruguay','Vietnam','Zambia','Zimbabwe',
].sort()

const VOLUME_OPTIONS = [
  'Under 10 GB / month',
  '10 – 50 GB / month',
  '50 – 200 GB / month',
  '200 GB – 1 TB / month',
  'Over 1 TB / month',
]

function SettingsPageInner() {
  const [profile, setProfile] = useState<any>(null)
  const [form, setForm] = useState({ full_name: '', company_name: '' })
  const [pw, setPw] = useState({ next: '', confirm: '' })
  const [loading, setLoading] = useState(false)

  // Reseller application form state
  const [applying, setApplying] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [appForm, setAppForm] = useState({
    full_name: '',
    country: '',
    phone: '',
    monthly_volume: '',
  })

  useEffect(() => {
    const sb = createClient()
    sb.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      const { data } = await sb.from('profiles').select('*').eq('id', user.id).single()
      setProfile(data)
      setForm({ full_name: data?.full_name ?? '', company_name: data?.company_name ?? '' })
      // Pre-fill name if available
      if (data?.full_name) setAppForm(f => ({ ...f, full_name: data.full_name }))
    })
  }, [])

  const searchParams = useSearchParams()
  useEffect(() => {
    if (searchParams.get('apply_reseller') === '1') setShowForm(true)
  }, [searchParams])

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault(); setLoading(true)
    const { error } = await createClient().from('profiles').update(form).eq('id', profile.id)
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
    else { toast.success('Password updated'); setPw({ next: '', confirm: '' }) }
    setLoading(false)
  }

  async function submitApplication(e: React.FormEvent) {
    e.preventDefault()
    if (!appForm.full_name || !appForm.country || !appForm.phone || !appForm.monthly_volume) {
      toast.error('Please fill in all fields'); return
    }
    setApplying(true)
    try {
      const res = await fetch('/api/auth/apply-reseller', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appForm),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to apply')
      toast.success('Application submitted! We\'ll review and get back to you.')
      setProfile({ ...profile, reseller_status: 'pending' })
      setShowForm(false)
    } catch (err: any) {
      toast.error(err.message)
    }
    setApplying(false)
  }

  return (
    <div className="max-w-2xl">
      <div className="mb-8">
        <h1 className="font-display font-bold text-2xl text-ink">Settings</h1>
        <p className="text-muted text-sm mt-1">Manage your account details</p>
      </div>

      {/* Profile */}
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-5">Profile</h2>
        <form onSubmit={saveProfile} className="flex flex-col gap-4">
          <div>
            <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Email</label>
            <input value={profile?.email ?? ''} disabled
              className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm text-muted cursor-not-allowed" />
          </div>
          {([['Full name', 'full_name', 'Your name'], ['Company name', 'company_name', 'Your business name (optional)']] as const).map(([l, k, p]) => (
            <div key={k}>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">{l}</label>
              <input value={(form as any)[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} placeholder={p}
                className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
            </div>
          ))}
          <button type="submit" disabled={loading}
            className="self-start bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
            {loading ? 'Saving...' : 'Save changes'}
          </button>
        </form>
      </div>

      {/* Change password */}
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-5">Change password</h2>
        <form onSubmit={changePassword} className="flex flex-col gap-4">
          {([['New password', 'next', 'Min. 8 characters'], ['Confirm password', 'confirm', 'Repeat new password']] as const).map(([l, k, p]) => (
            <div key={k}>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">{l}</label>
              <input type="password" placeholder={p} value={(pw as any)[k]}
                onChange={e => setPw({ ...pw, [k]: e.target.value })}
                className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
            </div>
          ))}
          <button type="submit" disabled={loading}
            className="self-start border border-border text-ink2 px-6 py-2.5 rounded-xl text-sm font-medium hover:border-ink2 hover:text-ink disabled:opacity-60 transition-all">
            {loading ? 'Updating...' : 'Update password'}
          </button>
        </form>
      </div>

      {/* Reseller application */}
      {profile?.role === 'user' && profile?.reseller_status !== 'pending' && (
        <div className="bg-accent2-light border border-accent2/20 rounded-xl p-6">
          <h2 className="font-display font-bold text-base text-accent2 mb-2">Become a reseller</h2>
          <p className="text-sm text-ink2 font-light mb-4">
            Buy wholesale bandwidth and resell under your own brand. No minimum commitment.
          </p>

          {!showForm ? (
            <button onClick={() => setShowForm(true)}
              className="inline-flex items-center gap-2 bg-accent2 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 transition-opacity">
              Apply now →
            </button>
          ) : (
            <form onSubmit={submitApplication} className="flex flex-col gap-4 mt-2">
              {/* Name */}
              <div>
                <label className="block text-[10px] font-mono text-accent2/70 uppercase tracking-wider mb-1.5">Full name *</label>
                <input
                  type="text"
                  value={appForm.full_name}
                  onChange={e => setAppForm({ ...appForm, full_name: e.target.value })}
                  placeholder="Your full name"
                  required
                  className="w-full bg-white border border-accent2/20 px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent2 transition-colors"
                />
              </div>

              {/* Country */}
              <div>
                <label className="block text-[10px] font-mono text-accent2/70 uppercase tracking-wider mb-1.5">Country *</label>
                <select
                  value={appForm.country}
                  onChange={e => setAppForm({ ...appForm, country: e.target.value })}
                  required
                  className="w-full bg-white border border-accent2/20 px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent2 transition-colors"
                >
                  <option value="">Select your country</option>
                  {COUNTRIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>

              {/* Phone */}
              <div>
                <label className="block text-[10px] font-mono text-accent2/70 uppercase tracking-wider mb-1.5">Phone / WhatsApp *</label>
                <input
                  type="tel"
                  value={appForm.phone}
                  onChange={e => setAppForm({ ...appForm, phone: e.target.value })}
                  placeholder="+1 555 000 0000"
                  required
                  className="w-full bg-white border border-accent2/20 px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent2 transition-colors"
                />
              </div>

              {/* Monthly volume */}
              <div>
                <label className="block text-[10px] font-mono text-accent2/70 uppercase tracking-wider mb-1.5">Expected monthly volume *</label>
                <select
                  value={appForm.monthly_volume}
                  onChange={e => setAppForm({ ...appForm, monthly_volume: e.target.value })}
                  required
                  className="w-full bg-white border border-accent2/20 px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent2 transition-colors"
                >
                  <option value="">Select expected volume</option>
                  {VOLUME_OPTIONS.map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>

              <div className="flex gap-3 mt-1">
                <button type="submit" disabled={applying}
                  className="bg-accent2 text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
                  {applying ? 'Submitting...' : 'Submit application →'}
                </button>
                <button type="button" onClick={() => setShowForm(false)}
                  className="border border-accent2/20 text-accent2 px-5 py-2.5 rounded-xl text-sm hover:bg-white transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {profile?.reseller_status === 'pending' && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-6">
          <h2 className="font-display font-bold text-base text-yellow-800 mb-2">Application under review</h2>
          <p className="text-sm text-yellow-700 font-light">
            We've received your application and will be in touch shortly.
          </p>
        </div>
      )}
    </div>
  )
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="max-w-2xl text-sm text-muted">Loading...</div>}>
      <SettingsPageInner />
    </Suspense>
  )
}
