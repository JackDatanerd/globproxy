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

  // Default auto-allocate
  const [defaultAuto, setDefaultAuto] = useState({ enabled: false, threshold_gb: 1, amount_gb: 5 })
  const [defaultAutoLoading, setDefaultAutoLoading] = useState(false)

  // Webhooks
  const [webhooks, setWebhooks] = useState<any[]>([])
  const [webhooksLoading, setWebhooksLoading] = useState(true)
  const [newWebhookUrl, setNewWebhookUrl] = useState('')
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>(['session_created', 'bandwidth_threshold_crossed'])
  const [creatingWebhook, setCreatingWebhook] = useState(false)
  // Shown exactly once, right after creation — the API never returns the
  // secret again after this response (see app/api/dashboard/webhooks/route.ts).
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

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

      const { data: bw } = await sb.from('bandwidth_accounts')
        .select('default_auto_topup_enabled, default_auto_topup_threshold_gb, default_auto_topup_amount_gb')
        .eq('user_id', user.id).single()
      if (bw) {
        setDefaultAuto({
          enabled: bw.default_auto_topup_enabled ?? false,
          threshold_gb: bw.default_auto_topup_threshold_gb ?? 1,
          amount_gb: bw.default_auto_topup_amount_gb ?? 5,
        })
      }
    })

    fetch('/api/dashboard/webhooks')
      .then(r => r.json())
      .then(d => setWebhooks(d.webhooks ?? []))
      .catch(() => {})
      .finally(() => setWebhooksLoading(false))
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

  async function saveDefaultAuto(e?: React.FormEvent) {
    e?.preventDefault()
    if (defaultAuto.enabled) {
      if (!Number.isFinite(defaultAuto.threshold_gb) || defaultAuto.threshold_gb < 0) {
        toast.error('Threshold must be 0 or greater'); return
      }
      if (!Number.isFinite(defaultAuto.amount_gb) || defaultAuto.amount_gb <= 0) {
        toast.error('Top-up amount must be greater than 0'); return
      }
    }
    setDefaultAutoLoading(true)
    const res = await fetch('/api/dashboard/settings/auto-topup-default', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(defaultAuto),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) toast.error(data.error ?? 'Failed to save default')
    else toast.success(defaultAuto.enabled ? 'Default auto-allocate saved' : 'Default auto-allocate turned off')
    setDefaultAutoLoading(false)
  }

  async function createWebhook(e: React.FormEvent) {
    e.preventDefault()
    if (newWebhookEvents.length === 0) { toast.error('Select at least one event'); return }
    setCreatingWebhook(true)
    const res = await fetch('/api/dashboard/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: newWebhookUrl.trim(), event_types: newWebhookEvents }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) {
      toast.error(data.error ?? 'Failed to add webhook')
    } else {
      setRevealedSecret(data.webhook.secret)
      setWebhooks(w => [{ ...data.webhook, secret: undefined }, ...w])
      setNewWebhookUrl('')
    }
    setCreatingWebhook(false)
  }

  async function toggleWebhook(id: string, enabled: boolean) {
    const res = await fetch(`/api/dashboard/webhooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) { toast.error(data.error ?? 'Failed to update webhook'); return }
    setWebhooks(w => w.map(x => x.id === id ? { ...x, enabled } : x))
  }

  async function deleteWebhook(id: string) {
    if (!confirm('Delete this webhook? It will stop receiving events immediately.')) return
    const res = await fetch(`/api/dashboard/webhooks/${id}`, { method: 'DELETE' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) toast.error(data.error ?? 'Failed to delete webhook')
    else { toast.success('Webhook deleted'); setWebhooks(w => w.filter(x => x.id !== id)) }
  }

  async function testWebhook(id: string) {
    setTestingId(id)
    const res = await fetch(`/api/dashboard/webhooks/${id}/test`, { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.error) toast.error(data.error ?? 'Test delivery failed — check the endpoint is reachable')
    else toast.success('Test event delivered')
    setTestingId(null)
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

      {/* Default auto-allocate */}
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="font-display font-bold text-base text-ink">Default auto-allocate</h2>
          <button
            type="button"
            onClick={() => setDefaultAuto(d => ({ ...d, enabled: !d.enabled }))}
            aria-pressed={defaultAuto.enabled}
            className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${defaultAuto.enabled ? 'bg-accent' : 'bg-border'}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${defaultAuto.enabled ? 'translate-x-4' : ''}`} />
          </button>
        </div>
        <p className="text-xs text-muted mb-4">
          Pre-fills the auto-allocate section on new proxy sessions with these numbers. Each session's own settings can still be changed
          before it's created, or afterward from its Bandwidth tab — this only saves you re-typing the same values every time.
        </p>
        {defaultAuto.enabled && (
          <form onSubmit={saveDefaultAuto} className="flex flex-wrap items-end gap-3 mb-1">
            <div>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">When remaining falls below</label>
              <div className="relative">
                <input type="number" min={0} step={0.1} value={defaultAuto.threshold_gb}
                  onChange={e => setDefaultAuto(d => ({ ...d, threshold_gb: +e.target.value }))}
                  className="w-32 bg-surface border border-border px-3.5 py-2.5 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors pr-9" />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-mono text-muted pointer-events-none">GB</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Add</label>
              <div className="relative">
                <input type="number" min={0.1} step={0.1} value={defaultAuto.amount_gb}
                  onChange={e => setDefaultAuto(d => ({ ...d, amount_gb: +e.target.value }))}
                  className="w-32 bg-surface border border-border px-3.5 py-2.5 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors pr-9" />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-mono text-muted pointer-events-none">GB</span>
              </div>
            </div>
            <button type="submit" disabled={defaultAutoLoading}
              className="border border-border text-ink2 px-5 py-2.5 rounded-xl text-sm font-medium hover:border-ink2 hover:text-ink disabled:opacity-60 transition-all">
              {defaultAutoLoading ? 'Saving...' : 'Save default'}
            </button>
          </form>
        )}
        {!defaultAuto.enabled && (
          <button onClick={() => saveDefaultAuto()} disabled={defaultAutoLoading}
            className="text-xs font-mono text-muted hover:text-ink transition-colors">
            {defaultAutoLoading ? 'Saving...' : 'Save (off)'}
          </button>
        )}
      </div>

      {/* Webhooks */}
      <div className="bg-white border border-border rounded-xl p-6 mb-5">
        <h2 className="font-display font-bold text-base text-ink mb-2">Webhooks</h2>
        <p className="text-xs text-muted mb-4">
          Get an HTTP POST when a session is created or your bandwidth crosses 80%/95%. Each request is signed with your endpoint's
          secret via an <span className="font-mono">X-GlobProxy-Signature</span> header (hex HMAC-SHA256 of the raw body) so you can verify it came from us.
        </p>

        {revealedSecret && (
          <div className="bg-accent-light border border-accent/30 rounded-xl p-5 mb-5">
            <h3 className="font-display font-bold text-sm text-ink mb-1.5">Your signing secret</h3>
            <p className="text-xs text-muted mb-3">
              Copy this now — we only show it once and can't display it again after you leave this page. If you lose it, delete the
              webhook and create a new one.
            </p>
            <div className="bg-white border border-border rounded-lg p-3 flex items-center gap-3">
              <span className="font-mono text-xs text-ink flex-1 truncate">{revealedSecret}</span>
              <button onClick={() => { navigator.clipboard.writeText(revealedSecret); toast.success('Secret copied') }}
                className="text-xs font-mono text-accent border border-accent/30 px-2.5 py-1 rounded-lg transition-colors flex-shrink-0">
                Copy
              </button>
            </div>
            <button onClick={() => setRevealedSecret(null)} className="text-xs text-muted hover:text-ink mt-3">
              Done, I've saved it
            </button>
          </div>
        )}

        {webhooksLoading ? (
          <p className="text-sm text-muted mb-4">Loading...</p>
        ) : webhooks.length === 0 ? (
          <p className="text-sm text-muted mb-4">No webhooks yet.</p>
        ) : (
          <div className="flex flex-col gap-2 mb-5">
            {webhooks.map(w => (
              <div key={w.id} className={`border border-border rounded-lg p-3 ${w.enabled ? '' : 'opacity-50'}`}>
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-ink font-mono truncate">{w.url}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {w.event_types.join(', ')}
                      {w.last_failure_at && (!w.last_success_at || new Date(w.last_failure_at) > new Date(w.last_success_at))
                        ? <span className="text-red-500"> · last delivery failed{w.last_error ? ` (${w.last_error})` : ''}</span>
                        : w.last_success_at ? <span className="text-green-600"> · delivering OK</span> : ' · no deliveries yet'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button onClick={() => testWebhook(w.id)} disabled={testingId === w.id}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50">
                      {testingId === w.id ? 'Sending...' : 'Send test'}
                    </button>
                    <button onClick={() => toggleWebhook(w.id, !w.enabled)}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                      {w.enabled ? 'Disable' : 'Enable'}
                    </button>
                    <button onClick={() => deleteWebhook(w.id)}
                      className="text-xs font-mono text-muted hover:text-red-500 border border-border hover:border-red-200 px-2.5 py-1 rounded-lg transition-colors">
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <form onSubmit={createWebhook} className="border-t border-border pt-4">
          <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Endpoint URL</label>
          <input type="url" placeholder="https://your-server.com/webhooks/globproxy" value={newWebhookUrl}
            onChange={e => setNewWebhookUrl(e.target.value)}
            className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm font-mono focus:outline-none focus:border-accent transition-colors mb-3" />
          <div className="flex flex-wrap gap-4 mb-4">
            {[
              ['session_created', 'Session created'],
              ['bandwidth_threshold_crossed', 'Bandwidth crossed 80%/95%'],
            ].map(([val, label]) => (
              <label key={val} className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={newWebhookEvents.includes(val)}
                  onChange={e => setNewWebhookEvents(evs => e.target.checked ? [...evs, val] : evs.filter(x => x !== val))}
                  className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-accent" />
                <span className="text-xs text-ink2">{label}</span>
              </label>
            ))}
          </div>
          <button type="submit" disabled={creatingWebhook || !newWebhookUrl.trim()}
            className="border border-border text-ink2 px-6 py-2.5 rounded-xl text-sm font-medium hover:border-ink2 hover:text-ink disabled:opacity-60 transition-all">
            {creatingWebhook ? 'Adding...' : 'Add webhook'}
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
