'use client'
import { useState } from 'react'
import toast from 'react-hot-toast'
import { downloadFile, toastApiError } from '@/lib/clientApi'

// A download that survives an expired 2FA session (redirects to verify) and
// reports failures as a toast — see downloadFile.
export default function ExportButton({
  url, filename, className, children,
}: { url: string; filename: string; className?: string; children: React.ReactNode }) {
  const [busy, setBusy] = useState(false)
  async function go() {
    if (busy) return
    setBusy(true)
    try {
      await downloadFile(url, filename)
    } catch (err: any) {
      toastApiError(err, 'Export failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" onClick={go} disabled={busy} className={`${className ?? ''} disabled:opacity-50`}>
      {busy ? 'Preparing…' : children}
    </button>
  )
}
