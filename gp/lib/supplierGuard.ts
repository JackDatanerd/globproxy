// Our upstream proxy supplier must never be visible to customers: a customer who
// can name the supplier can buy from it directly. The places a name could slip
// through are the identifiers the supplier hands back — chiefly the proxy
// username it stores for a sub-user (its own dashboard exports use a prefixed
// form), which we then show to the customer as `username` / `connection_username`.
//
// We request our own neutral username ("gp_…") when provisioning; if the provider
// ever answers with something that names it instead, that must be caught BEFORE it
// is stored or shown.

const SUPPLIER_NAME = /geo[\s_.\-]*node/i

/** True when `value` contains the supplier's name in any spelling we would plausibly see. */
export function leaksSupplier(value: unknown): boolean {
  return typeof value === 'string' && SUPPLIER_NAME.test(value)
}

const SUPPLIER_NAME_GLOBAL = /geo[\s_.\-]*node/gi

/** `text` with any spelling of the supplier's name replaced by a neutral word. For text that is
 *  STORED somewhere the customer can read (their own profile row, an e-mail) and that may have
 *  been built from a raw upstream error. */
export function scrubSupplier(text: string): string {
  return text.replace(SUPPLIER_NAME_GLOBAL, 'upstream')
}
