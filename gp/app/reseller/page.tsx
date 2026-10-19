import { redirect } from 'next/navigation'

// /reseller had no index page (404) — but the approval email, the MFA-setup
// `next=/reseller` redirects and the layout all point here.
export default function ResellerIndex() {
  redirect('/reseller/users')
}
