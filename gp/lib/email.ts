export async function sendEmail(p: { to: string; subject: string; html: string }) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.FROM_EMAIL ?? 'noreply@globproxy.com', to: p.to, subject: p.subject, html: p.html }),
  })
}

export async function sendAccountDeletionEmail(p: { to: string; name: string }) {
  await sendEmail({
    to: p.to,
    subject: 'Your GlobProxy account has been deleted',
    html: `<p>Hi ${p.name},</p>
<p>Your GlobProxy account has been permanently deleted by an administrator.</p>
<p>If you believe this was a mistake, please contact us at support@globproxy.com.</p>
<p>— The GlobProxy Team</p>`,
  })
}
