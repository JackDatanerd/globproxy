import { createClient } from '@/lib/supabase/server'
import { sendTestWebhook } from '@/lib/webhooks'
import { NextResponse } from 'next/server'

export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await context.params
  const result = await sendTestWebhook(user.id, id)

  if (!result.ok) return NextResponse.json({ error: result.error ?? 'Delivery failed' }, { status: 502 })
  return NextResponse.json({ success: true })
}
