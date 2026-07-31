import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import DashSidebar from '@/components/dashboard/DashSidebar'
import DashTopbar from '@/components/dashboard/DashTopbar'

export default async function ResellerLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/auth/login')

  const { data: profile } = await supabase
    .from('profiles').select('*').eq('id', user.id).single()

  if (profile?.role !== 'reseller' && profile?.role !== 'admin') redirect('/dashboard')
  // Defense-in-depth — see app/dashboard/layout.tsx for rationale.
  if (profile?.is_suspended) redirect('/auth/login?suspended=1')

  return (
    <div className="min-h-screen bg-surface flex flex-col">
      <DashTopbar profile={profile} />
      <div className="flex flex-1 overflow-hidden">
        <DashSidebar role={profile?.role} apiAccess={profile?.api_access ?? false} />
        <main className="flex-1 p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  )
}
