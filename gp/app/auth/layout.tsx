import Link from 'next/link'
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <div className="p-6"><Link href="/" className="font-display font-black text-2xl text-ink tracking-tight">Glob<span className="text-accent">Proxy</span></Link></div>
      <div className="flex-1 flex items-center justify-center p-6">{children}</div>
    </div>
  )
}
