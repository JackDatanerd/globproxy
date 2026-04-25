'use client'
import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import toast from 'react-hot-toast'

export default function PaymentVerifier() {
  const params = useSearchParams()
  const router = useRouter()
  const ran = useRef(false)

  useEffect(() => {
    const payment = params.get('payment')
    const reference = params.get('reference')
    if (!payment || !reference || ran.current) return
    ran.current = true

    async function verify() {
      const toastId = toast.loading('Confirming your payment...')
      try {
        const res = await fetch('/api/verify-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reference }),
        })
        const data = await res.json()
        if (data.success) {
          toast.success('Bandwidth credited to your account!', { id: toastId })
          // Clean URL and refresh to show updated balance
          router.replace('/dashboard')
          router.refresh()
        } else {
          toast.error(data.error || 'Payment verification failed', { id: toastId })
        }
      } catch {
        toast.error('Could not verify payment', { id: toastId })
      }
    }

    verify()
  }, [params, router])

  return null
}