'use client'
import { useEffect, useRef, useState } from 'react'

// Copy-paste snippet for blog posts. Self-contained on purpose: the dashboard's
// copyText helper lives in lib/clientApi, which pulls the toast library and the
// re-auth prompt into the bundle — far too much for a public article page.
async function copy(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

export default function CodeBlock({ code, language, caption }: { code: string; language?: string; caption?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  async function onCopy() {
    const ok = await copy(code)
    setState(ok ? 'copied' : 'failed')
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1800)
  }

  return (
    <figure className="my-6">
      {caption && <figcaption className="text-xs font-mono text-subtle mb-2">{caption}</figcaption>}
      <div className="bg-ink rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-2 border-b border-white/10">
          <span className="text-[10px] font-mono text-white/60 uppercase tracking-widest">{language ?? 'text'}</span>
          <button
            type="button"
            onClick={onCopy}
            className="text-[10px] font-mono text-white/60 hover:text-white border border-white/15 px-2.5 py-1 rounded transition-colors"
          >
            {state === 'copied' ? 'copied' : state === 'failed' ? 'select & copy manually' : 'copy'}
          </button>
        </div>
        {/* tabIndex: a keyboard user must be able to scroll a long line sideways. */}
        <pre tabIndex={0} className="px-4 py-4 overflow-x-auto text-[13px] font-mono text-white/80 leading-6">
          <code>{code}</code>
        </pre>
      </div>
    </figure>
  )
}
