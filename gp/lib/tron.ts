// TRON (TRC20) address validation with a real base58check verification.
// A TRON address is 25 bytes: 0x41 prefix + 20-byte hash + 4-byte checksum
// (first 4 bytes of sha256(sha256(first 21 bytes))). The old
// /^T[1-9A-HJ-NP-Za-km-z]{33}$/ check accepted any typo that kept the
// alphabet — and a mistyped USDT destination is an unrecoverable loss.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

function base58Decode(s: string): Uint8Array | null {
  const base = BigInt(58)
  let n = BigInt(0)
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch)
    if (v < 0) return null
    n = n * base + BigInt(v)
  }
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  const body: number[] = []
  for (let i = 0; i < hex.length; i += 2) body.push(parseInt(hex.slice(i, i + 2), 16))
  let zeros = 0
  for (const ch of s) {
    if (ch === '1') zeros++
    else break
  }
  // n === 0 only for an all-'1' string, which has no valid body.
  const bytes = n === BigInt(0) ? [] : body
  return new Uint8Array([...new Array(zeros).fill(0), ...bytes])
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer)
  return new Uint8Array(digest)
}

export async function isValidTronAddress(address: unknown): Promise<boolean> {
  if (typeof address !== 'string' || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address)) return false
  const raw = base58Decode(address)
  if (!raw || raw.length !== 25 || raw[0] !== 0x41) return false
  const hash = await sha256(await sha256(raw.slice(0, 21)))
  const checksum = raw.slice(21)
  return checksum.every((b, i) => b === hash[i])
}
