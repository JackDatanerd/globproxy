'use client'
import TwoFactorSettings from '@/components/dashboard/TwoFactorSettings'
import { ChangePasswordCard, SecurityActivityCard, ActiveSessionsCard } from '@/components/dashboard/AccountSecurityCards'

// Account & security for the admin's own login on Platform Settings (admin
// has its own settings page instead of visiting /dashboard/settings). Uses
// the same shared cards as the user settings page, so password changes go
// through the server flow — current password, 2FA step-up if enrolled,
// other sessions revoked — rather than a browser-side updateUser() call.
// Two-factor authentication is optional here as everywhere; the layout
// shows a recommendation banner until it is turned on.
export default function AdminAccountSecurity() {
  return (
    <>
      <ChangePasswordCard className="mt-5" />
      <TwoFactorSettings role="admin" />
      <ActiveSessionsCard className="mt-5" />
      <SecurityActivityCard className="mt-5" />
    </>
  )
}
