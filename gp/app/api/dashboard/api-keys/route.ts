import { createAdminClient, createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'

const PREFIX = 'gp_live_'

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const token = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
  return `${PREFIX}${token}`
}

// List this user's keys (hash never returned — only id/prefix/label/dates)
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, key_prefix, label, created_at, last_used_at, revoked_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ keys: data })
}

// Create a new key. The plaintext value is returned exactly once — only the
// hash is persisted, so it can never be shown again after this response.
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { data: profile } = await supabase.from('profiles').select('role, api_access, is_suspended').eq('id', user.id).single()
  if (profile?.is_suspended) return NextResponse.json({ error: 'Account suspended' }, { status: 403 })
  if (profile?.role === 'user' || (!profile?.api_access && profile?.role !== 'admin')) {
    return NextResponse.json({ error: 'API access is not enabled for your account.' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  const label = (typeof body.label === 'string' ? body.label.trim() : '').slice(0, 60) || 'Default key'

  const plaintext = generateKey()
  const key_hash = await sha256Hex(plaintext)
  const key_prefix = plaintext.slice(0, PREFIX.length + 6) // e.g. gp_live_a1b2c3

  // Insert via admin client — creation is intentionally not covered by an
  // RLS insert policy (see migration 0005), since the hash has to be
  // computed server-side anyway.
  const admin = await createAdminClient()
  const { data, error } = await admin
    .from('api_keys')
    .insert({ user_id: user.id, key_hash, key_prefix, label })
    .select('id, key_prefix, label, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // `key` is only ever present in this one response.
  return NextResponse.json({ key: plaintext, meta: data }, { status: 201 })
}

// Revoke a key (soft delete — sets revoked_at, doesn't remove the row so
// last_used_at history stays visible).
export async function DELETE(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await req.json().catch(() => ({}))
  if (!id) return NextResponse.json({ error: 'Missing key id' }, { status: 400 })

  const { data: revoked, error } = await supabase
    .from('api_keys')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', user.id)
    .select('id')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!revoked || revoked.length === 0) {
    return NextResponse.json({ error: 'Key not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true })
}
