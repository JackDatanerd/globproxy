// Server-side password policy. The `minLength={8}` on the forms is a UX hint
// only — anyone posting to the API (or calling Supabase directly) skips it —
// so every server route that sets a password calls this too.
//
// Upper bound: bcrypt (what GoTrue uses) only looks at the first 72 BYTES;
// longer inputs are rejected by GoTrue, so reject them here with a clear
// message instead of a cryptic upstream error.
export function validatePassword(password: unknown, email?: string | null): { ok: true } | { ok: false; error: string } {
  if (typeof password !== 'string') return { ok: false, error: 'Password is required.' }
  if (password.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' }
  if (new TextEncoder().encode(password).length > 72) {
    return { ok: false, error: 'Password is too long (max 72 bytes).' }
  }
  if (/^\s+$/.test(password)) return { ok: false, error: 'Password cannot be only spaces.' }
  if (email && password.toLowerCase() === email.toLowerCase()) {
    return { ok: false, error: 'Password cannot be the same as your email address.' }
  }
  if (/^(.)\1+$/.test(password)) return { ok: false, error: 'Choose a less repetitive password.' }
  return { ok: true }
}
