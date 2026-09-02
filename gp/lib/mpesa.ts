// Accepts the common ways a Kenyan Safaricom number gets typed —
// 07XXXXXXXX, 01XXXXXXXX, 2547XXXXXXXX, 2541XXXXXXXX, +254... — and
// normalizes to the 2547XXXXXXXX / 2541XXXXXXXX form (no plus, no
// leading zero), which is the unambiguous format for both M-Pesa API
// use later and for whoever's reading this off the admin payouts screen
// to do a manual transfer today.
export function normalizeMpesaPhone(input: string): string | null {
  const digits = input.replace(/[^\d]/g, '')

  let normalized: string | null = null
  if (/^0[71]\d{8}$/.test(digits)) {
    normalized = '254' + digits.slice(1)
  } else if (/^254[71]\d{8}$/.test(digits)) {
    normalized = digits
  } else if (/^[71]\d{8}$/.test(digits)) {
    normalized = '254' + digits
  }

  return normalized
}
