import { NextResponse } from 'next/server'
import { buildOpenApi } from '@/lib/openapi'
import { appUrl } from '@/lib/appUrl'

// GET /api/v1/openapi.json — the machine-readable API description. Public (no
// key): it documents the contract, not any account's data.
export async function GET() {
  return NextResponse.json(buildOpenApi(appUrl()), { headers: { 'Cache-Control': 'public, max-age=300' } })
}
