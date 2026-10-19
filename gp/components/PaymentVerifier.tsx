'use client'
import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import toast from 'react-hot-toast'
import { confirmPayment } from '@/lib/verifyPayment'

// Handles the redirect-fallback return trip from Paystack
// (/dashboard?payment=success&reference=…). Only an explicit `success`
// triggers verification, and the params are always stripped afterwards so a
// refresh doesn't re-run it. "Still processing" and "confirmed, crediting"
// are shown as neutral notices, not errors: the webhook / reconcile cron
// finish those on their own.
export default function PaymentVerifier() {
  const params = useSearchParams()
  const router = useRouter()
  const ran = useRef(false)

  useEffect(() => {
    const payment = params.get('payment')
    const reference = params.get('reference')
    if (payment !== 'success' || !reference || ran.current) return
    ran.current = true

    async function verify() {
      const toastId = toast.loading('Confirming your payment...')
      const result = await confirmPayment(reference!)
      if (result.success) {
        toast.success('Bandwidth credited to your account!', { id: toastId })
      } else if (result.delayed) {
        toast(result.error || "Your payment is confirmed — your bandwidth will appear in a few minutes.", { id: toastId, duration: 10000, icon: '⏳' })
      } else if (result.pending) {
        toast("Your payment is still being processed. Your bandwidth will appear automatically once it's confirmed.", { id: toastId, duration: 10000, icon: '⏳' })
      } else {
        toast.error(result.error || 'Payment verification failed', { id: toastId })
      }
      // Clean the URL (so a refresh doesn't re-verify) and show the new balance.
      router.replace('/dashboard')
      router.refresh()
    }

    verify()
  }, [params, router])

  return null
}
