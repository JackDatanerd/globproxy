import { getCloudflareContext } from '@opennextjs/cloudflare'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Makes an unauthenticated "did that email exist?" endpoint take the same
 * wall-clock time on every branch.
 *
 * Padding fast branches up to a fixed floor only works while the floor is
 * ABOVE the slow branch (a real email dispatch), which no constant can
 * promise. So the slow branch is also capped: the response goes out at the
 * floor whether or not `work` has finished, and `work` is kept alive with
 * waitUntil() so Workers doesn't cancel it. Anything that must be on the
 * response (cookies) has to be set before `work`'s network call — true for
 * the PKCE code-verifier, which auth-js writes before it contacts GoTrue.
 */
const PENDING = Symbol('pending')

/** Resolves to `work`'s value if it finished inside the floor, otherwise undefined (it keeps running in the background). */
export async function holdUntil<T>(startedAt: number, floorMs: number, work?: Promise<T>): Promise<T | undefined> {
  const deadline = startedAt + floorMs
  let value: T | undefined
  if (work) {
    const settled = work.then(v => v as T | typeof PENDING, () => undefined)
    try { getCloudflareContext({ async: false }).ctx.waitUntil(settled) } catch { /* not on Workers (dev): fall through */ }
    const first = await Promise.race([settled, sleep(Math.max(0, deadline - Date.now())).then(() => PENDING)])
    value = first === PENDING ? undefined : (first as T | undefined)
  }
  const left = deadline - Date.now()
  if (left > 0) await sleep(left)
  return value
}
