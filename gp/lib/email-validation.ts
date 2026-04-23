const BLOCKED = new Set(['mailinator.com','guerrillamail.com','guerrillamail.net','guerrillamail.org','tempmail.com','temp-mail.org','throwaway.email','sharklasers.com','guerrillamail.info','spam4.me','yopmail.com','yopmail.fr','10minutemail.com','trashmail.com','trashmail.me','trashmail.net','dispostable.com','mailnull.com','spamgourmet.com','maildrop.cc','throwam.com','getnada.com','filzmail.com','discard.email','fakeinbox.com','mailnesia.com','mohmal.com','tempinbox.com','mail-temp.com','tempr.email','wegwerfadresse.de','wegwerfemail.de','spamoff.de','pookmail.com'])

export function validateEmail(email: string): { valid: boolean; error?: string } {
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { valid: false, error: 'Please enter a valid email address.' }
  if (BLOCKED.has(domain)) return { valid: false, error: 'Disposable email addresses are not allowed. Please use a real email.' }
  return { valid: true }
}
