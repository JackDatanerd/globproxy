// Client-safe (no server imports) labels for the security_events table.
export const SECURITY_EVENT_LABELS: Record<string, string> = {
  login: 'Signed in',
  password_changed: 'Password changed',
  email_change_requested: 'Email change requested',
  mfa_enabled: 'Two-factor authentication enabled',
  mfa_disabled: 'Two-factor authentication disabled',
  mfa_backup_regenerated: 'Backup codes regenerated',
  mfa_backup_code_used: 'Backup code used to sign in',
  mfa_locked: 'Too many incorrect 2FA codes — temporarily locked',
  mfa_reset_by_admin: 'Two-factor authentication reset by support',
  signout_others: 'Signed out of all other devices',
}
