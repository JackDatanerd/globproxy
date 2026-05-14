import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'

export async function DELETE(req: Request) {
  try {
    const supabase = await createClient()

    // 1. Verify user requesting deletion
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const adminSupabase = await createAdminClient()

    // 2. Forcibly delete connected records that usually cause foreign key violations
    // (If these throw errors, it's fine, we try to clear them out regardless)
    await adminSupabase.from('bandwidth_accounts').delete().eq('user_id', user.id)
    await adminSupabase.from('proxy_credentials').delete().eq('user_id', user.id)
    
    // Wipe history of reseller transfers involving this user
    await adminSupabase.from('reseller_transfers')
      .delete()
      .or(`reseller_id.eq.${user.id},recipient_id.eq.${user.id}`)

    // Finally delete profile row manually (often fails to cascade purely through auth delete)
    await adminSupabase.from('profiles').delete().eq('id', user.id)

    // 3. Terminate Auth account permanently
    const { error: deleteError } = await adminSupabase.auth.admin.deleteUser(user.id)

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: 'Account deleted' })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}