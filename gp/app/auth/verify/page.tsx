import Link from 'next/link'
export default function VerifyPage() {
  return (
    <div className="w-full max-w-md">
      <div className="bg-white border border-border rounded-2xl p-10 shadow-sm text-center">
        <div className="text-4xl mb-5">📬</div>
        <h1 className="font-display font-bold text-2xl text-ink mb-2">Check your inbox</h1>
        <p className="text-muted text-sm font-light leading-relaxed mb-7">We sent a confirmation link to your email. Click it to activate your account.</p>
        <p className="text-xs text-muted">Didn&apos;t receive it? <Link href="/auth/signup" className="text-accent hover:underline">Try again</Link> or check your spam folder.</p>
      </div>
    </div>
  )
}
