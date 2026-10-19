'use client'
import { useState, useEffect, Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import toast from 'react-hot-toast'
import TwoFactorSettings from '@/components/dashboard/TwoFactorSettings'
import { ChangePasswordCard, ChangeEmailCard, SecurityActivityCard } from '@/components/dashboard/AccountSecurityCards'
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS } from '@/lib/webhookEvents'
import { apiFetch, apiJson, copyText } from '@/lib/clientApi'
import { formatGb } from '@/lib/format'

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
  const router = useRouter()
  const [profile, setProfile] = useState<any>(null)
  const [form, setForm] = useState({ full_name: '', company_name: '' })
  const [loading, setLoading] = useState(false)
  const [deleting, setDeleting] = useState(false)
  // Delete-account panel: replaces two back-to-back confirm() dialogs with a
  // typed confirmation that spells out what is lost.
  const [showDelete, setShowDelete] = useState(false)
  const [deleteText, setDeleteText] = useState('')
  const [deleteFacts, setDeleteFacts] = useState<{ remainingGb: number; sessions: number } | null>(null)
  const [profileError, setProfileError] = useState<string | null>(null)

  // Default auto-allocate
  const [defaultAuto, setDefaultAuto] = useState({ enabled: false, threshold_gb: 1, amount_gb: 5 })
  const [defaultAutoLoading, setDefaultAutoLoading] = useState(false)

  // Webhooks
  const [webhooks, setWebhooks] = useState<any[]>([])
  const [webhooksLoading, setWebhooksLoading] = useState(true)
  const [webhooksError, setWebhooksError] = useState<string | null>(null)
  // In-place editing of an endpoint's URL / events (PATCH already supported
  // both; the UI only ever offered enable/disable).
  const [editingWebhookId, setEditingWebhookId] = useState<string | null>(null)
  const [editUrl, setEditUrl] = useState('')
  const [editEvents, setEditEvents] = useState<string[]>([])
  const [savingWebhook, setSavingWebhook] = useState(false)
  const [newWebhookUrl, setNewWebhookUrl] = useState('')
  const [newWebhookEvents, setNewWebhookEvents] = useState<string[]>(['session_created', 'bandwidth_threshold_crossed', 'bandwidth_exhausted'])
  const [creatingWebhook, setCreatingWebhook] = useState(false)
  // Shown exactly once, right after creation — the API never returns the
  // secret again after this response (see app/api/dashboard/webhooks/route.ts).
  // Carries the endpoint URL so the banner says WHICH secret this is.
  const [revealedSecret, setRevealedSecret] = useState<{ url: string; secret: string } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  // Delivery log: one endpoint's log open at a time.
  const [logId, setLogId] = useState<string | null>(null)
  const [logRows, setLogRows] = useState<any[]>([])
  const [logLoading, setLogLoading] = useState(false)

  // Reseller application form state
  const [applying, setApplying] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [appForm, setAppForm] = useState({
    full_name: '',
    country: '',
    phone: '',
    monthly_volume: '',
  })

  async function loadWebhooks() {
    setWebhooksLoading(true)
    try {
      const d = await apiFetch('/api/dashboard/webhooks')
      setWebhooks(d.webhooks ?? [])
      setWebhooksError(null)
    } catch (e: any) {
      // Used to be swallowed: a failed load looked identical to "No webhooks yet".
      setWebhooksError(e?.message || 'Couldn\u2019t load your webhooks')
    } finally {
      setWebhooksLoading(false)
    }
  }

  useEffect(() => {
    const sb = createClient()
    sb.auth.getUser().then(async ({ data: { user } }) => {
      if (!user) return
      // Only the columns this page uses — `select('*')` also pulled payout
      // bank details and application JSON into component state.
      const { data, error } = await sb.from('profiles')
        .select('id, email, full_name, company_name, role, reseller_status')
        .eq('id', user.id).single()
      if (error || !data) { setProfileError('Couldn\u2019t load your profile. Refresh the page to try again.'); return }
      setProfile(data)
      setForm({ full_name: data?.full_name ?? '', company_name: data?.company_name ?? '' })
      // Pre-fill name if available
      if (data?.full_name) setAppForm(f => ({ ...f, full_name: data.full_name }))

      const { data: bw } = await sb.from('bandwidth_accounts')
        .select('default_auto_topup_enabled, default_auto_topup_threshold_gb, default_auto_topup_amount_gb, total_gb, used_gb')
        .eq('user_id', user.id).maybeSingle()
      if (bw) {
        setDefaultAuto({
          enabled: bw.default_auto_topup_enabled ?? false,
          threshold_gb: bw.default_auto_topup_threshold_gb ?? 1,
          amount_gb: bw.default_auto_topup_amount_gb ?? 5,
        })
      }
      const { count } = await sb.from('proxy_credentials').select('id', { count: 'exact', head: true }).eq('user_id', user.id)
      setDeleteFacts({ remainingGb: Math.max(0, (bw?.total_gb ?? 0) - (bw?.used_gb ?? 0)), sessions: count ?? 0 })
    })

    loadWebhooks()
  }, [])

  const searchParams = useSearchParams()
  useEffect(() => {
    if (searchParams.get('apply_reseller') === '1') setShowForm(true)
  }, [searchParams])

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault()
    if (!profile) return // not loaded yet (or failed to load) — nothing to save against
    const clean = { full_name: form.full_name.trim().slice(0, 100), company_name: form.company_name.trim().slice(0, 100) }
    if (!clean.full_name) { toast.error('Please enter your name'); return }
    setLoading(true)
    const { error } = await createClient().from('profiles').update({ ...clean, company_name: clean.company_name || null }).eq('id', profile.id)
    if (error) toast.error('Couldn\u2019t save your profile. Please try again.')
    else { toast.success('Profile updated'); setForm(clean) }
    setLoading(false)
  }

  // Hits app/api/user/delete-account. One-way anonymisation, so the UI makes
  // the person type DELETE after reading what is actually lost (it used to be
  // two reflexive confirm() popups that said nothing about remaining GB).
  async function deleteAccount() {
    if (deleteText.trim().toUpperCase() !== 'DELETE') return
    setDeleting(true)
    try {
      await apiJson('DELETE', '/api/user/delete-account')
      await fetch('/api/auth/mfa/logout', { method: 'POST' }).catch(() => {})
      await createClient().auth.signOut()
      toast.success('Account deleted')
      router.push('/')
      router.refresh()
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err.message ?? 'Failed to delete account')
      setDeleting(false)
    }
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
      if (defaultAuto.amount_gb <= defaultAuto.threshold_gb) {
        toast.error('The amount added must be larger than the threshold, or it would re-trigger immediately.'); return
      }
    }
    setDefaultAutoLoading(true)
    try {
      await apiJson('PATCH', '/api/dashboard/settings/auto-topup-default', defaultAuto)
      toast.success(defaultAuto.enabled ? 'Default auto-allocate saved' : 'Default auto-allocate turned off')
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to save default')
    }
    setDefaultAutoLoading(false)
  }

  // A signing secret is shown once. Creating or rotating a second one while
  // the first banner is still up replaced it — the first secret was lost for
  // good with no warning. Make the person dismiss it first.
  function secretPending(): boolean {
    if (!revealedSecret) return false
    toast.error('Copy your current signing secret and click \u201cDone\u201d first \u2014 it can\u2019t be shown again.')
    return true
  }

  async function createWebhook(e: React.FormEvent) {
    e.preventDefault()
    if (secretPending()) return
    if (newWebhookEvents.length === 0) { toast.error('Select at least one event'); return }
    setCreatingWebhook(true)
    try {
      const data = await apiJson('POST', '/api/dashboard/webhooks', { url: newWebhookUrl.trim(), event_types: newWebhookEvents })
      setRevealedSecret({ url: data.webhook.url, secret: data.webhook.secret })
      setWebhooks(w => [{ ...data.webhook, secret: undefined }, ...w])
      setNewWebhookUrl('')
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err.message ?? 'Failed to add webhook')
    }
    setCreatingWebhook(false)
  }

  async function toggleWebhook(id: string, enabled: boolean) {
    try {
      const data = await apiJson('PATCH', `/api/dashboard/webhooks/${id}`, { enabled })
      setWebhooks(w => w.map(x => x.id === id ? { ...x, ...(data.webhook ?? { enabled }) } : x))
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err.message ?? 'Failed to update webhook')
    }
  }

  function startEditWebhook(w: any) {
    setEditingWebhookId(w.id)
    setEditUrl(w.url)
    setEditEvents([...(w.event_types ?? [])])
  }

  async function saveWebhookEdit(id: string) {
    if (editEvents.length === 0) { toast.error('Select at least one event'); return }
    setSavingWebhook(true)
    try {
      const data = await apiJson('PATCH', `/api/dashboard/webhooks/${id}`, { url: editUrl.trim(), event_types: editEvents })
      setWebhooks(w => w.map(x => x.id === id ? { ...x, ...data.webhook } : x))
      setEditingWebhookId(null)
      toast.success('Webhook updated')
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err.message ?? 'Failed to update webhook')
    }
    setSavingWebhook(false)
  }

  async function deleteWebhook(id: string) {
    if (!confirm('Delete this webhook? It will stop receiving events immediately.')) return
    try {
      await apiJson('DELETE', `/api/dashboard/webhooks/${id}`)
      toast.success('Webhook deleted')
      setWebhooks(w => w.filter(x => x.id !== id))
      if (logId === id) setLogId(null)
      if (editingWebhookId === id) setEditingWebhookId(null)
    } catch (err: any) {
      toast.error(err.message ?? 'Failed to delete webhook')
    }
  }

  async function testWebhook(id: string) {
    setTestingId(id)
    try {
      await apiJson('POST', `/api/dashboard/webhooks/${id}/test`)
      toast.success('Test event delivered')
    } catch (err: any) {
      toast.error(err.message ?? 'Test delivery failed — check the endpoint is reachable')
    }
    setTestingId(null)
  }

  async function rotateWebhookSecret(id: string) {
    if (secretPending()) return
    if (!confirm('Rotate the signing secret? The current secret stops working immediately — update your receiver with the new one.')) return
    try {
      const data = await apiJson('POST', `/api/dashboard/webhooks/${id}/rotate-secret`)
      setRevealedSecret({ url: webhooks.find(w => w.id === id)?.url ?? 'webhook', secret: data.secret })
    } catch (err: any) {
      if (err?.code !== 'mfa_required') toast.error(err.message ?? 'Failed to rotate secret')
    }
  }

  async function loadDeliveries(id: string) {
    setLogLoading(true)
    try {
      const data = await apiFetch(`/api/dashboard/webhooks/${id}/deliveries?limit=25`)
      setLogRows(data.deliveries ?? [])
    } catch (err: any) {
      setLogRows([])
      toast.error(err.message ?? 'Failed to load deliveries')
    }
    setLogLoading(false)
  }

  async function toggleLog(id: string) {
    if (logId === id) { setLogId(null); return }
    setLogId(id)
    await loadDeliveries(id)
  }

  async function redeliver(endpointId: string, deliveryId: string) {
    try {
      await apiJson('POST', `/api/dashboard/webhooks/${endpointId}/deliveries/${deliveryId}/redeliver`)
      toast.success('Event redelivered')
    } catch (err: any) {
      toast.error(err.message ?? 'Redelivery failed')
    }
    await loadDeliveries(endpointId)
  }

  async function submitApplication(e: React.FormEvent) {
    e.preventDefault()
    if (!appForm.full_name || !appForm.country || !appForm.phone || !appForm.monthly_volume) {
      toast.error('Please fill in all fields'); return
    }
    setApplying(true)
    try {
      await apiJson('POST', '/api/auth/apply-reseller', appForm)
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

      {profileError && (
        <div className="mb-5 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">{profileError}</div>
      )}

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
              <input value={(form as any)[k]} onChange={e => setForm({ ...form, [k]: e.target.value })} placeholder={p} maxLength={100}
                className="w-full bg-surface border border-border px-4 py-3 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors" />
            </div>
          ))}
          <button type="submit" disabled={loading || !profile}
            className="self-start bg-accent text-white px-6 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity">
            {loading ? 'Saving...' : 'Save changes'}
          </button>
        </form>
      </div>

      {/* Change password — server-side: current password + 2FA step-up, revokes other sessions */}
      <ChangePasswordCard />

      {/* Change email — current password + 2FA step-up, double confirmation, notice to old address */}
      <ChangeEmailCard currentEmail={profile?.email} />

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
                <input type="number" inputMode="decimal" min={0} step="any" value={defaultAuto.threshold_gb}
                  onChange={e => setDefaultAuto(d => ({ ...d, threshold_gb: +e.target.value }))}
                  className="w-32 bg-surface border border-border px-3.5 py-2.5 rounded-xl text-sm focus:outline-none focus:border-accent transition-colors pr-9" />
                <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] font-mono text-muted pointer-events-none">GB</span>
              </div>
            </div>
            <div>
              <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Add</label>
              <div className="relative">
                <input type="number" inputMode="decimal" min={0.01} step="any" value={defaultAuto.amount_gb}
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
          Get an HTTP POST when sessions change or your bandwidth runs low. Each request is signed with your endpoint's
          secret (<span className="font-mono">X-GlobProxy-Signature-V2</span> carries a timestamp for replay protection;
          <span className="font-mono"> X-GlobProxy-Signature</span> is the plain HMAC-SHA256 of the body). Failed deliveries are retried
          for up to ~9 hours, and an endpoint that keeps failing is disabled automatically. See the{' '}
          <a href="/docs/api#webhooks" target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">webhook docs</a>.
        </p>

        {revealedSecret && (
          <div className="bg-accent-light border border-accent/30 rounded-xl p-5 mb-5">
            <h3 className="font-display font-bold text-sm text-ink mb-1.5">Your signing secret</h3>
            <p className="text-[11px] font-mono text-muted mb-2 truncate">for {revealedSecret.url}</p>
            <p className="text-xs text-muted mb-3">
              Copy this now — we only show it once and can't display it again after you leave this page. If you lose it, use
              “Rotate secret” on the webhook to generate a new one.
            </p>
            <div className="bg-white border border-border rounded-lg p-3 flex items-center gap-3">
              <span className="font-mono text-xs text-ink flex-1 truncate select-all">{revealedSecret.secret}</span>
              <button onClick={async () => { (await copyText(revealedSecret.secret)) ? toast.success('Secret copied') : toast.error('Couldn\u2019t access the clipboard — select the secret and copy it manually.') }}
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
        ) : webhooksError ? (
          <p className="text-sm text-red-500 mb-4">{webhooksError}{' '}
            <button onClick={loadWebhooks} className="underline hover:opacity-70">Retry</button>
          </p>
        ) : webhooks.length === 0 ? (
          <p className="text-sm text-muted mb-4">No webhooks yet.</p>
        ) : (
          <div className="flex flex-col gap-2 mb-5">
            {webhooks.map(w => (
              <div key={w.id} className={`border border-border rounded-lg p-3 ${w.enabled ? '' : 'opacity-50'}`}>
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-sm text-ink font-mono truncate max-w-full">{w.url}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {w.event_types.join(', ')}
                      {!w.enabled && w.disabled_reason ? <span className="text-red-500"> · disabled: {w.disabled_reason}</span> : null}
                      {w.last_failure_at && (!w.last_success_at || new Date(w.last_failure_at) > new Date(w.last_success_at))
                        ? <span className="text-red-500"> · last delivery failed{w.last_error ? ` (${w.last_error})` : ''}</span>
                        : w.last_success_at ? <span className="text-green-600"> · delivering OK</span> : ' · no deliveries yet'}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <button onClick={() => testWebhook(w.id)} disabled={testingId === w.id}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors disabled:opacity-50">
                      {testingId === w.id ? 'Sending...' : 'Send test'}
                    </button>
                    <button onClick={() => (editingWebhookId === w.id ? setEditingWebhookId(null) : startEditWebhook(w))}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                      {editingWebhookId === w.id ? 'Cancel' : 'Edit'}
                    </button>
                    <button onClick={() => toggleLog(w.id)}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                      {logId === w.id ? 'Hide log' : 'Log'}
                    </button>
                    <button onClick={() => rotateWebhookSecret(w.id)}
                      className="text-xs font-mono text-muted hover:text-ink border border-border px-2.5 py-1 rounded-lg transition-colors">
                      Rotate secret
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
                {editingWebhookId === w.id && (
                  <div className="mt-3 border-t border-border pt-3">
                    <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">Endpoint URL</label>
                    <input type="url" value={editUrl} onChange={e => setEditUrl(e.target.value)}
                      className="w-full bg-surface border border-border px-3 py-2 rounded-lg text-sm font-mono focus:outline-none focus:border-accent transition-colors mb-3" />
                    <div className="flex flex-wrap gap-4 mb-3">
                      {WEBHOOK_EVENTS.map(val => (
                        <label key={val} className="flex items-center gap-2 cursor-pointer select-none">
                          <input type="checkbox" checked={editEvents.includes(val)}
                            onChange={e => setEditEvents(evs => e.target.checked ? [...evs, val] : evs.filter(x => x !== val))}
                            className="w-3.5 h-3.5 rounded border-border text-accent focus:ring-accent" />
                          <span className="text-xs text-ink2">{WEBHOOK_EVENT_LABELS[val]}</span>
                        </label>
                      ))}
                    </div>
                    <p className="text-[11px] text-muted mb-3">The signing secret stays the same when you change the URL.</p>
                    <button onClick={() => saveWebhookEdit(w.id)} disabled={savingWebhook || !editUrl.trim()}
                      className="bg-accent text-white px-4 py-2 rounded-lg text-xs font-medium hover:opacity-90 disabled:opacity-60">
                      {savingWebhook ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                )}
                {logId === w.id && (
                  <div className="mt-3 border-t border-border pt-3">
                    {logLoading ? (
                      <p className="text-xs text-muted">Loading...</p>
                    ) : logRows.length === 0 ? (
                      <p className="text-xs text-muted">No deliveries in the last 14 days.</p>
                    ) : (
                      <div className="flex flex-col gap-1.5">
                        {logRows.map(d => (
                          <div key={d.id} className="flex items-center justify-between gap-3 text-xs font-mono">
                            <div className="min-w-0 truncate">
                              <span className={d.status === 'succeeded' ? 'text-green-600' : d.status === 'retrying' ? 'text-amber-600' : 'text-red-500'}>
                                {d.status}
                              </span>
                              <span className="text-ink2"> · {d.event_type}</span>
                              <span className="text-muted"> · {new Date(d.created_at).toLocaleString()}</span>
                              <span className="text-muted"> · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}</span>
                              {d.response_status ? <span className="text-muted"> · HTTP {d.response_status}</span> : null}
                              {d.last_error && d.status !== 'succeeded' ? <span className="text-red-500"> · {d.last_error}</span> : null}
                            </div>
                            {d.event_type !== 'test' && (
                              <button onClick={() => redeliver(w.id, d.id)}
                                className="text-muted hover:text-ink border border-border px-2 py-0.5 rounded-lg flex-shrink-0">
                                Redeliver
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
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
            {WEBHOOK_EVENTS.map((val) => [val, WEBHOOK_EVENT_LABELS[val]] as const).map(([val, label]) => (
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

      {profile && <TwoFactorSettings role={profile.role ?? 'user'} />}

      <SecurityActivityCard />

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

      {/* Danger zone — was previously implemented server-side
          (app/api/user/delete-account) with no button anywhere to reach
          it. Kept visually separate (border color, position at the very
          end) from every reversible action above it. */}
      <div className="bg-white border border-red-200 rounded-xl p-6 mt-5">
        <h2 className="font-display font-bold text-base text-red-600 mb-2">Danger zone</h2>
        <p className="text-sm text-ink2 font-light mb-4">
          Permanently delete your account. Your proxy credentials stop working immediately and your
          personal data is anonymised. This cannot be undone.
        </p>
        {!showDelete ? (
          <button onClick={() => setShowDelete(true)}
            className="border border-red-200 text-red-500 px-6 py-2.5 rounded-xl text-sm font-medium hover:bg-red-50 transition-all">
            Delete my account…
          </button>
        ) : (
          <div className="bg-red-50 border border-red-200 rounded-xl p-4">
            <p className="text-sm text-red-700 font-medium mb-2">This will permanently:</p>
            <ul className="text-sm text-red-700 list-disc pl-5 mb-3 space-y-1">
              <li>
                Delete {deleteFacts ? `${deleteFacts.sessions} proxy session${deleteFacts.sessions === 1 ? '' : 's'}` : 'all your proxy sessions'} — they stop working immediately.
              </li>
              <li>
                Forfeit {deleteFacts ? <strong>{formatGb(deleteFacts.remainingGb)} GB</strong> : 'any'} of unused bandwidth. It is not refunded or transferable.
              </li>
              <li>Remove your name, email, payout details, webhooks and revoke your API keys.</li>
            </ul>
            <label className="block text-xs text-red-700 mb-1.5">Type <span className="font-mono font-bold">DELETE</span> to confirm</label>
            <input value={deleteText} onChange={e => setDeleteText(e.target.value)} autoComplete="off"
              className="w-full max-w-xs bg-white border border-red-200 px-3 py-2 rounded-lg text-sm font-mono focus:outline-none focus:border-red-400 mb-3" />
            <div className="flex gap-3">
              <button onClick={deleteAccount} disabled={deleting || deleteText.trim().toUpperCase() !== 'DELETE'}
                className="bg-red-600 text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-40 transition-all">
                {deleting ? 'Deleting...' : 'Permanently delete my account'}
              </button>
              <button onClick={() => { setShowDelete(false); setDeleteText('') }} disabled={deleting}
                className="border border-border text-ink2 px-5 py-2.5 rounded-xl text-sm hover:text-ink">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
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
