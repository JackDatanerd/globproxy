// Payout details are write-only in the browser. The referrals page used to
// serialise the full wallet address, bank account number and M-Pesa phone into
// the page HTML and pre-fill the edit form with them — readable by anything
// that could read the page, with no re-authentication, while CHANGING them
// needs 2FA/password. Only masked forms go to the client; to change a payout
// method the customer re-enters it.

export function maskWallet(addr: string | null | undefined): string | null {
  if (!addr) return null
  const a = String(addr)
  return a.length <= 10 ? '••••' : `${a.slice(0, 4)}…${a.slice(-4)}`
}

export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const p = String(phone)
  if (p.length <= 6) return '••••'
  return `${p.slice(0, 4)}${'•'.repeat(Math.max(2, p.length - 7))}${p.slice(-3)}`
}

export type MaskedBank = { bankName?: string; country?: string; accountLast4?: string }

export function maskBank(b: any): MaskedBank | null {
  if (!b || typeof b !== 'object') return null
  const num = typeof b.accountNumber === 'string' ? b.accountNumber.replace(/\s+/g, '') : ''
  return {
    bankName: typeof b.bankName === 'string' ? b.bankName : undefined,
    country: typeof b.country === 'string' ? b.country : undefined,
    accountLast4: num ? num.slice(-4) : undefined,
  }
}
