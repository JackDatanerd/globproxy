import { escapeHtml } from '@/lib/email'

// Branded shell shared by the admin-triggered notification emails. Callers
// pass already-escaped HTML for bodyHtml (use escapeHtml on anything
// user-controlled); heading and cta.label are plain text and escaped here.
export function adminNoticeHtml(opts: {
  heading: string
  bodyHtml: string
  cta?: { href: string; label: string }
}): string {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">
      <img src="https://globproxy.com/og-image.png" alt="GlobProxy" width="200"
        style="display:block;margin:0 auto 32px auto;border-radius:12px;"/>
      <h2 style="text-align:center;color:#111;">${escapeHtml(opts.heading)}</h2>
      <p style="color:#444;text-align:center;">${opts.bodyHtml}</p>
      ${opts.cta ? `
      <div style="text-align:center;margin:32px 0;">
        <a href="${opts.cta.href}"
           style="background:#2563eb;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:600;">
          ${escapeHtml(opts.cta.label)}
        </a>
      </div>` : ''}
      <p style="color:#bbb;font-size:12px;text-align:center;margin-top:32px;">
        © 2026 GlobProxy · Residential Proxies That Never Expire
      </p>
    </div>
  `
}

export const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? 'https://globproxy.com'
