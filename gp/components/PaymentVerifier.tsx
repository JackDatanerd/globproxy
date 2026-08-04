'use client'
import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import toast from 'react-hot-toast'
import { verifyPayment } from '@/lib/verifyPayment'

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
      const result = await verifyPayment(reference!)
      if (result.success) {
        toast.success('Bandwidth credited to your account!', { id: toastId })
        // Clean URL and refresh to show updated balance
        router.replace('/dashboard')
        router.refresh()
      } else {
        toast.error(result.error || 'Payment verification failed', { id: toastId })
      }
    }

    verify()
  }, [params, router])

  return null
}