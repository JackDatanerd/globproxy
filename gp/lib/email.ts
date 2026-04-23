export async function sendEmail(p: { to: string; subject: string; html: string }) {
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.FROM_EMAIL ?? 'noreply@globproxy.com', to: p.to, subject: p.subject, html: p.html }),
  })
}
