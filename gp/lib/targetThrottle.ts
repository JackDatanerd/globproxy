// Pure (import-free) rules for the per-TARGET-EMAIL throttle on signup / password reset /
// resend-confirmation, so they can be unit-tested without the Workers runtime.
//
// THE PROBLEM THIS SHAPE SOLVES. A cap keyed on the target address alone ("6 requests per
// 10 minutes for victim@x.com, from anyone") is also a lock: whoever knows the address can
// spend the whole budget and keep the owner's own request answered with a 429. For
// password reset that is an account-recovery denial — and recovery is the documented way
// out of the sign-in throttle (lib/authThrottle.ts THROTTLE_ACCOUNT_MSG). Worse, an e-mail
// triggered by someone else is useless to the owner (the PKCE verifier cookie lives in
// the browser that asked), so the owner's own request has to be able to go through.
//
// So there are two exact (Postgres) buckets, checked in this order:
//   1. per (target, calling address): the cap that actually stops one source hammering an
//      inbox. The owner's request comes from a different address, so it has its own bucket
//      and is never counted against the attacker's.
//   2. per target across every address, over an hour: a ceiling for a flood spread over
//      many addresses. A single address is stopped by (1) before it can reach this
//      bucket, so it takes MANY addresses to push the owner into it; the inbox is still
//      bounded to TARGET_GLOBAL_MAX mails an hour.
// (1) is checked first and returns early, so a blocked address does not keep feeding (2).

export const TARGET_PER_ADDRESS_MAX = 4
export const TARGET_PER_ADDRESS_WINDOW_S = 600 // 10 minutes
export const TARGET_GLOBAL_MAX = 40
export const TARGET_GLOBAL_WINDOW_S = 3600 // 1 hour

export type TargetBucket = {
  /** Which rule this is (drives the message the caller answers with). */
  kind: 'address' | 'global'
  scope: string
  identifier: string
  max: number
  windowS: number
}

// One mailbox, one key. `victim+1@gmail.com`, `victim+2@gmail.com` and
// `v.ictim@gmail.com` all deliver to the same inbox, so keying the per-target
// limit on the literal string let an attacker flood a victim with a fresh
// budget per variant. Strips a `+tag` (honoured by essentially every provider
// that matters), and for Gmail also ignores dots and folds googlemail.com.
export function canonicalEmail(raw: string): string {
  const e = raw.trim().toLowerCase()
  const at = e.lastIndexOf('@')
  if (at < 1) return e
  let local = e.slice(0, at)
  let domain = e.slice(at + 1)
  const plus = local.indexOf('+')
  if (plus > 0) local = local.slice(0, plus)
  if (domain === 'googlemail.com') domain = 'gmail.com'
  if (domain === 'gmail.com') local = local.replace(/\./g, '')
  return `${local}@${domain}`
}

/** The ordered exact buckets for one request. `ip` is the normalised client address, or null when unknown. */
export function targetBuckets(scope: string, target: string, ip: string | null): TargetBucket[] {
  const out: TargetBucket[] = []
  if (ip) {
    out.push({ kind: 'address', scope: `target-ip:${scope}`, identifier: `${target}|${ip}`, max: TARGET_PER_ADDRESS_MAX, windowS: TARGET_PER_ADDRESS_WINDOW_S })
  }
  out.push({ kind: 'global', scope: `target:${scope}`, identifier: target, max: TARGET_GLOBAL_MAX, windowS: TARGET_GLOBAL_WINDOW_S })
  return out
}
