'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'

interface Client {
  id: string
  email: string
  full_name: string | null
  total_gb_received: number
  latest_transfer: string
}

interface Props {
  clients: Client[]
  availableGb: number
}

export default function ResellerUsersList({ clients, availableGb }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({ gb: 1, email: '' })

  async function transfer(
    e: React.FormEvent | null,
    targetEmail?: string,
    // Use undefined, not a falsy default — so 0 never silently falls back to form.gb
    targetGb?: number
  ) {
    if (e) e.preventDefault()

    const emailToUse = targetEmail ?? form.email
    // Explicit undefined check — if targetGb is passed (even as 0), use it.
    // Only fall back to form.gb when targetGb was never provided.
    const gbToUse = targetGb !== undefined ? targetGb : form.gb

    if (!emailToUse) { toast.error('Client email is required'); return }
    if (gbToUse <= 0) { toast.error('GB amount must be greater than 0'); return }
    if (gbToUse > availableGb) { toast.error('Not enough bandwidth in your stock'); return }

    setLoading(true)
    try {
      const res = await fetch('/api/reseller/allocate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recipient_email: emailToUse,
          gb_allocated: gbToUse,
        }),
      })

      const data = await res.json()
      if (!res.ok) throw new Error(data.error)

      toast.success(`${gbToUse}GB successfully transferred to ${emailToUse}`)
      setOpen(false)
      setForm({ gb: 1, email: '' })
      router.refresh()
    } catch (err: any) {
      toast.error(err.message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {/* ── Transfer form ── */}
      <div className="bg-white border border-border rounded-xl mb-5">
        <button
          onClick={() => setOpen(!open)}
          className="w-full flex items-center justify-between p-5 text-left"
        >
          <div>
            <div className="font-medium text-ink text-sm">Transfer bandwidth to a client</div>
            <div className="text-xs text-muted mt-0.5">Transfers GB directly to their account balance.</div>
          </div>
          <span className={`text-xl text-muted transition-transform ${open ? 'rotate-45' : ''}`}>+</span>
        </button>

        {open && (
          <div className="px-5 pb-5 border-t border-border pt-5">
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">
                  Client email *
                </label>
                <input
                  required
                  type="email"
                  value={form.email}
                  onChange={e => setForm({ ...form, email: e.target.value })}
                  placeholder="client@example.com"
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent"
                />
              </div>

              <div>
                <label className="block text-[10px] font-mono text-muted uppercase tracking-wider mb-1.5">
                  GB to transfer *
                </label>
                <input
                  required
                  type="number"
                  min={0.1}
                  step={0.1}
                  max={availableGb}
                  value={form.gb}
                  onChange={e => setForm({ ...form, gb: +e.target.value })}
                  className="w-full bg-surface border border-border px-3 py-2.5 rounded-lg text-sm focus:outline-none focus:border-accent"
                />
                <div className="text-[10px] font-mono text-muted mt-1">
                  {availableGb.toFixed(2)} GB available in stock
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={(e) => transfer(e)}
                disabled={loading}
                className="bg-accent text-white px-5 py-2.5 rounded-xl text-sm font-medium hover:opacity-90 disabled:opacity-60 transition-opacity"
              >
                {loading ? 'Transferring...' : `Transfer ${form.gb}GB →`}
              </button>
              <button
                type="button"
                onClick={() => { setOpen(false); setForm({ gb: 1, email: '' }) }}
                className="border border-border text-muted px-5 py-2.5 rounded-xl text-sm hover:text-ink transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Client roster ── */}
      <h3 className="text-sm font-medium text-ink mb-3 mt-8">Your Client Roster</h3>
      <div className="flex flex-col gap-3">
        {clients.length > 0 ? (
          clients.map(client => (
            <div
              key={client.id}
              className="bg-white border border-border rounded-xl p-5 flex items-center justify-between"
            >
              <div>
                <div className="font-medium text-ink text-sm">{client.email}</div>
                {client.full_name && (
                  <div className="text-xs text-muted mt-0.5">{client.full_name}</div>
                )}
                <div className="text-xs text-muted mt-1">
                  Total transferred:{' '}
                  <span className="font-medium text-ink">
                    {client.total_gb_received.toFixed(2)} GB
                  </span>
                </div>
              </div>

              <button
                onClick={() => transfer(null, client.email, 1)}
                disabled={loading || availableGb < 1}
                className="text-xs border border-border px-4 py-2 rounded-lg hover:border-accent hover:text-accent disabled:opacity-50 transition-colors"
              >
                + Quick Send 1GB
              </button>
            </div>
          ))
        ) : (
          <div className="bg-white border border-border rounded-xl p-14 text-center">
            <p className="text-muted text-sm font-light">
              No clients yet. Transfer bandwidth above to start building your roster.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
