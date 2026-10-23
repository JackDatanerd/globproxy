// Pure (no server imports): why a proxy credential is 'suspended'
// (proxy_credentials.suspended_reason). Shared by the admin pages so a
// customer's own pause is never mislabelled as an admin / account-level action.
export function suspendedReasonLabel(reason: string | null | undefined): string {
  switch (reason) {
    case 'admin': return 'disabled individually'
    case 'account': return 'with the account'
    case 'customer': return 'paused by the customer'
    case 'deleted': return 'account deleted'
    default: return 'with the account' // NULL = suspended before the column existed (account-level)
  }
}
