import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST(req: Request) {
  try {
    const supabase = await createClient()

    // 1. Authenticate user from browser cookies
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // 2. Set their profile status to 'pending'
    const { error: updateError } = await supabase
      .from('profiles')
      .update({ reseller_status: 'pending' })
      .eq('id', user.id)

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 })
    }

    // (Optional) Email the admin to let them know - uncomment/hook up if you want
    // import { sendAdminEmail } from '@/lib/email'
    // await sendAdminEmail(`New Reseller Application! Email: ${user.email}`)

    return NextResponse.json({ success: true, message: 'Application submitted successfully' })
    
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}