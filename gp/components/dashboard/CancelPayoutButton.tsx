'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import toast from 'react-hot-toast'
import { apiJson, toastApiError } from '@/lib/clientApi'

// Lets an affiliate cancel their own scheduled payout (nothing sent yet), e.g. when the
// destination it was created with is wrong. The commissions return to their balance.
export default function CancelPayoutButton({ payoutId }: { payoutId: string }) {
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function cancel() {
    if (!window.confirm('Cancel this scheduled payout?\n\nNothing has been sent yet. The commissions go back into your balance and are included in your next payout, using the payout method on file at that time — so fix your payout method first if it is wrong. A changed method is on a short security hold.')) return
    setLoading(true)
    try {
      await apiJson('POST', '/api/dashboard/cancel-payout', { payoutId })
      toast.success('Payout cancelled — the amount is back in your balance')
      router.refresh()
    } catch (err: any) {
      toastApiError(err, 'Could not cancel this payout')
    } finally {
      setLoading(false)
    }
  }

  return (
    <button onClick={cancel} disabled={loading}
      className="text-[10px] font-mono text-muted hover:text-red-500 underline underline-offset-2 disabled:opacity-50">
      {loading ? 'Cancelling…' : 'Wrong details? Cancel'}
    </button>
  )
}
