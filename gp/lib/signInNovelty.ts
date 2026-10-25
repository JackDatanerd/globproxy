// Import-free so tests/security-notices.test.mjs can load it directly (see lib/securityNotices.ts).

/**
 * Is this sign-in "new" enough to e-mail the owner about? A device (user-agent fingerprint) not
 * seen in the look-back window, OR a country not seen in it — but a country only counts once the
 * account has at least one country on record (sign-ins from before countries were stored carry
 * none, and flagging every long-standing customer's next login would be noise). The very first
 * sign-in ever recorded is never new: there is nothing to compare against.
 */
export function isNewSignIn(p: { hadPriorLogin: boolean; sameDeviceSeen: boolean; country: string | null; countriesSeen: ReadonlySet<string> }): boolean {
  if (!p.hadPriorLogin) return false
  const newCountry = !!p.country && p.countriesSeen.size > 0 && !p.countriesSeen.has(p.country)
  return !p.sameDeviceSeen || newCountry
}
