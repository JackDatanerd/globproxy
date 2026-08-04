// Thin wrapper around POST /api/verify-payment, shared by:
// - the Paystack inline popup's onSuccess handler (app/dashboard/buy/page.tsx)
// - PaymentVerifier, which handles the redirect-fallback return trip
// Keeping this in one place means both call sites stay in sync if the
// response shape or endpoint ever changes.

export interface VerifyPaymentResult {
  success: boolean
  already_paid?: boolean
  error?: string
}

export async function verifyPayment(reference: string): Promise<VerifyPaymentResult> {
  try {
    const res = await fetch('/api/verify-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference }),
    })
    const data = await res.json()
    if (!res.ok || !data.success) {
      return { success: false, error: data.error || 'Payment verification failed' }
    }
    return { success: true, already_paid: !!data.already_paid }
  } catch {
    return { success: false, error: 'Could not verify payment' }
  }
}
