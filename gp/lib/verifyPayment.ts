// Thin wrapper around POST /api/verify-payment, shared by:
// - the Paystack inline popup's onSuccess handler (app/dashboard/buy/page.tsx)
// - PaymentVerifier, which handles the redirect-fallback return trip
// Keeping this in one place means both call sites stay in sync if the
// response shape or endpoint ever changes.

export interface VerifyPaymentResult {
  success: boolean
  already_paid?: boolean
  // The payment has not settled yet (3-D Secure / OTP in flight, redirect
  // returned early). Not a failure — keep waiting.
  pending?: boolean
  // Paystack has the money but our credit hasn't committed yet; the webhook /
  // reconcile cron completes it within minutes. Not a failure either.
  delayed?: boolean
  error?: string
}

export async function verifyPayment(reference: string): Promise<VerifyPaymentResult> {
  try {
    const res = await fetch('/api/verify-payment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference }),
    })
    const data = await res.json().catch(() => ({}))
    if (res.ok && data.success) {
      return { success: true, already_paid: !!data.already_paid }
    }
    if (res.status === 429) {
      return { success: false, pending: true, error: 'Still confirming your payment…' }
    }
    return {
      success: false,
      pending: !!data.pending,
      delayed: !!data.delayed,
      error: data.error || 'Payment verification failed',
    }
  } catch {
    // Network blip: the money may well have moved — treat as "keep trying",
    // not as a definitive failure.
    return { success: false, pending: true, error: 'Could not verify payment' }
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// Verifies and, while the answer is "not yet" (pending / delayed / network),
// polls a handful of times before giving up. Resolves as soon as the answer is
// definitive: credited, or a real failure. If it runs out of attempts the last
// result is returned with pending/delayed still set so the caller can say
// "still processing — it will appear shortly" instead of "failed".
export async function confirmPayment(
  reference: string,
  opts: { attempts?: number; delayMs?: number; onWaiting?: () => void } = {},
): Promise<VerifyPaymentResult> {
  const attempts = opts.attempts ?? 8
  const delayMs = opts.delayMs ?? 3000
  let last: VerifyPaymentResult = { success: false, pending: true }
  for (let i = 0; i < attempts; i++) {
    last = await verifyPayment(reference)
    if (last.success || (!last.pending && !last.delayed)) return last
    if (i < attempts - 1) {
      opts.onWaiting?.()
      await sleep(delayMs)
    }
  }
  return last
}
