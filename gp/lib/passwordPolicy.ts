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

// ── Common / breached passwords ──────────────────────────────────────────
// Length and repetition rules alone accept "password1" and "qwerty123".
// 1. A built-in list of the most-used passwords (instant, offline).
// 2. Have I Been Pwned's range API (k-anonymity: only the first 5 hex chars of
//    the SHA-1 leave the server). Fail-open on any error or timeout so an
//    outage there can never block signups; set PASSWORD_BREACH_CHECK=off to
//    disable the network lookup.
const COMMON = new Set([
  'password','password1','password12','password123','password1234','passw0rd','p@ssw0rd','p@ssword','pass1234','passpass',
  '12345678','123456789','1234567890','11111111','00000000','12341234','123123123','87654321','987654321','1q2w3e4r',
  '1q2w3e4r5t','1qaz2wsx','qwertyui','qwertyuiop','qwerty123','qwerty12','qwerty1234','qwer1234','asdfghjk','asdfghjkl',
  'zxcvbnm1','abc12345','abcd1234','abcdefgh','abcd12345','iloveyou','iloveyou1','iloveyou2','letmein1','letmein123',
  'welcome1','welcome123','welcome12','admin123','admin1234','administrator','changeme','changeme1','default1','test1234',
  'testtest','testing123','sunshine','sunshine1','princess','princess1','football','football1','baseball','baseball1',
  'superman','superman1','batman123','master123','monkey123','dragon123','shadow123','michael1','jennifer','trustno1',
  'whatever','whatever1','starwars','starwars1','freedom1','computer','computer1','internet','internet1','mustang1',
  'access123','login123','hello123','hello1234','secret123','secret12','google123','facebook1','linkedin','pokemon1',
  'summer2020','summer2021','summer2022','summer2023','summer2024','winter2023','winter2024','spring2024','autumn2024',
  'password!','password1!','passw0rd1','globproxy','globproxy1','globproxy123','proxy123','proxies123','proxyproxy',
])

function isCommonPassword(password: string): boolean {
  const p = password.toLowerCase()
  if (COMMON.has(p)) return true
  // "Password1!" / "qwerty123!!!" — strip trailing punctuation and digits once.
  const stripped = p.replace(/[!@#$%^&*._-]+$/, '')
  return stripped !== p && COMMON.has(stripped)
}

async function pwnedCount(password: string): Promise<number> {
  if (process.env.PASSWORD_BREACH_CHECK === 'off') return 0
  try {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(password))
    const hex = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
    const prefix = hex.slice(0, 5)
    const suffix = hex.slice(5)
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'globproxy-password-check' },
      signal: AbortSignal.timeout(2500),
    })
    if (!res.ok) return 0
    for (const line of (await res.text()).split('\n')) {
      const [h, c] = line.trim().split(':')
      if (h === suffix) return Number(c) || 0
    }
    return 0
  } catch {
    return 0
  }
}

/** validatePassword() plus the common-password list and a breached-password lookup. */
export async function validatePasswordStrict(password: unknown, email?: string | null): Promise<{ ok: true } | { ok: false; error: string }> {
  const basic = validatePassword(password, email)
  if (!basic.ok) return basic
  const pw = password as string
  if (isCommonPassword(pw)) {
    return { ok: false, error: 'That password is too common. Choose something harder to guess.' }
  }
  if ((await pwnedCount(pw)) >= 3) {
    return { ok: false, error: 'That password has appeared in known data breaches. Please choose a different one.' }
  }
  return { ok: true }
}
