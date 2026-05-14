import { NextResponse } from 'next/server'
import { createClient, createAdminClient } from '@/lib/supabase/server'
// import { sendAccountDeletionEmail } from '@/lib/email' // Uncomment if you have your resend emailer ready

export async function DELETE(req: Request) {
  try {
    const supabase = await createClient()

    // 1. Verify it's actually the user requesting their own deletion via cookies
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // You NEED the admin service role to delete a user from the entire auth system
    const adminSupabase = await createAdminClient()

    // 2. Fire the goodbye email (Uncomment if needed)
    // if (user.email) {
    //   await sendAccountDeletionEmail(user.email)
    // }

    // 3. Terminate user. This automatically cascades and deletes their `profiles` row 
    // IF your Supabase foreign keys are setup with ON DELETE CASCADE.
    const { error: deleteError } = await adminSupabase.auth.admin.deleteUser(user.id)

    if (deleteError) {
      return NextResponse.json({ error: deleteError.message }, { status: 500 })
    }

    return NextResponse.json({ success: true, message: 'Account deleted' })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}