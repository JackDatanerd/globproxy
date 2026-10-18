// Accepts the common ways a Kenyan Safaricom number gets typed —
// 07XXXXXXXX, 01XXXXXXXX, 2547XXXXXXXX, 2541XXXXXXXX, +254... — and
// normalizes to the 2547XXXXXXXX / 2541XXXXXXXX form (no plus, no
// leading zero), which is the unambiguous format for both M-Pesa API
// use later and for whoever's reading this off the admin payouts screen
// to do a manual transfer today.
export function normalizeMpesaPhone(input: string): string | null {
  let digits = input.replace(/[^\d]/g, '')

  // "00254…" is the international-call prefix for +254.
  if (digits.startsWith('00254')) digits = digits.slice(2)
  // "+254 0712 345 678" — a very common slip: country code AND the local
  // leading zero. Drop the stray zero.
  if (/^2540[71]\d{8}$/.test(digits)) digits = '254' + digits.slice(4)

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
