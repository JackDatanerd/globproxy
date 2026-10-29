import Navbar from '@/components/Navbar'
import UnsubscribeButton from '@/components/UnsubscribeButton'
import { verifyUnsubscribe } from '@/lib/unsubscribe'
import { unsubscribeSecret } from '@/lib/broadcast'

export const metadata = { title: 'Unsubscribe — GlobProxy', robots: { index: false, follow: false } }

// The landing page of the footer link in product-news e-mails. It only SHOWS a button: unsubscribing is
// the POST behind it, so a mail scanner that opens the link cannot unsubscribe anyone by accident.
export default async function UnsubscribePage({ searchParams }: { searchParams: Promise<{ u?: string; t?: string }> }) {
  const { u = '', t = '' } = await searchParams
  const valid = await verifyUnsubscribe(unsubscribeSecret(), u, t)
  return (
    <>
      <Navbar />
      <div className="max-w-xl mx-auto px-6 py-16">
        <h1 className="font-display font-bold text-3xl text-ink tracking-tight mb-4">Product news &amp; offers</h1>
        {valid ? (
          <>
            <p className="text-sm text-ink2 mb-6">Stop receiving our announcements and offers by e-mail. Receipts, security notices and important notices about your account will still reach you.</p>
            <UnsubscribeButton u={u} t={t} />
          </>
        ) : (
          <p className="text-sm text-ink2">This unsubscribe link isn&apos;t valid. Sign in and turn off &ldquo;product news &amp; offers&rdquo; under Settings → E-mail notifications, or reply to the e-mail and we&apos;ll do it for you.</p>
        )}
      </div>
    </>
  )
}
