// Our upstream proxy supplier must never be visible to customers: a customer who
// can name the supplier can buy from it directly. The places a name could slip
// through are the identifiers the supplier hands back — chiefly the proxy
// username it stores for a sub-user (its own dashboard exports use a prefixed
// form), which we then show to the customer as `username` / `connection_username`.
//
// We request our own neutral username ("gp_…") when provisioning; if the provider
// ever answers with something that names it instead, that must be caught BEFORE it
// is stored or shown.

// Built from character codes so the name itself never sits in this (public) source.
const part = (...codes: number[]) => String.fromCharCode(...codes)
const NAME_PATTERN = part(103, 101, 111) + '[\\s_.\\-]*' + part(110, 111, 100, 101)
const SUPPLIER_NAME = new RegExp(NAME_PATTERN, 'i')

/** True when `value` contains the supplier's name in any spelling we would plausibly see. */
export function leaksSupplier(value: unknown): boolean {
  return typeof value === 'string' && SUPPLIER_NAME.test(value)
}

const SUPPLIER_NAME_GLOBAL = new RegExp(NAME_PATTERN, 'gi')

/** `text` with any spelling of the supplier's name replaced by a neutral word. For text that is
 *  STORED somewhere the customer can read (their own profile row, an e-mail) and that may have
 *  been built from a raw upstream error. */
export function scrubSupplier(text: string): string {
  return text.replace(SUPPLIER_NAME_GLOBAL, 'upstream')
}

/** True when any of the values names the supplier. For free text an admin types that a customer will read. */
export function anyLeaksSupplier(...values: unknown[]): boolean {
  return values.some(leaksSupplier)
}

export const SUPPLIER_TEXT_ERROR = 'This text names our upstream provider. Remove it before sending.'
