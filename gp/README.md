# GlobProxy — Fresh Deployment Guide

## Stack
- **Framework**: Next.js 15 (App Router)
- **Database + Auth**: Supabase
- **Payments**: Paystack (card + mobile money)
- **Proxy API**: Geonode Reseller API
- **Email**: Resend
- **Hosting**: Cloudflare Workers (via OpenNext)

---

## Step 1 — Install dependencies

```bash
npm install
```

---

## Step 2 — Supabase (fresh project)

1. Go to [supabase.com](https://supabase.com) → New project
2. SQL Editor → paste and run the entire contents of `supabase/schema.sql`
3. Copy your URL and keys from Settings → API

---

## Step 3 — Environment variables

```bash
copy .env.local.example .env.local
```

Fill in all values:

| Variable | Where to get it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API |
| `NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY` | Paystack dashboard → Settings → API Keys |
| `PAYSTACK_SECRET_KEY` | Paystack dashboard → Settings → API Keys |
| `PAYSTACK_WEBHOOK_SECRET` | Paystack dashboard → Settings → Webhooks |
| `GEONODE_API_KEY` | Geonode dashboard → API |
| `RESEND_API_KEY` | resend.com → API Keys |
| `FROM_EMAIL` | `noreply@globproxy.com` |
| `NEXT_PUBLIC_APP_URL` | `https://globproxy.com` |
| `ADMIN_EMAIL` | Your email address |

---

## Step 4 — Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

---

## Step 5 — Set yourself as admin

1. Sign up at `/auth/signup`
2. Supabase → Table Editor → `profiles` → find your row → set `role` to `admin`
3. Sign out and back in — you now have admin access at `/admin`

---

## Step 6 — Deploy to Cloudflare

```bash
npm run deploy
```

This runs `opennextjs-cloudflare build && opennextjs-cloudflare deploy`.

Add all environment variables in Cloudflare dashboard:
Workers & Pages → globproxy → Settings → Variables and Secrets

---

## Step 7 — Set up Paystack webhook

In Paystack dashboard → Settings → Webhooks:
- URL: `https://globproxy.com/api/webhooks/paystack`
- Events: `charge.success`

Copy the webhook secret into `PAYSTACK_WEBHOOK_SECRET` in your Cloudflare env vars.

---

## Step 8 — Connect globproxy.com

In Cloudflare dashboard:
Workers & Pages → globproxy → Custom Domains → Add `globproxy.com`

Since the domain is already on Cloudflare DNS, this connects automatically.

---

## How payments work

1. User selects a plan → `/api/checkout` creates a pending order and redirects to Paystack
2. User pays on Paystack's hosted page
3. Paystack fires `charge.success` webhook to `/api/webhooks/paystack`
4. Webhook calls `activateBandwidth()` which:
   - Marks order paid
   - Credits GB to user's account
   - Provisions any pending Geonode credentials
   - Activates pending reseller transfers
   - Sends confirmation email

---

## User roles

| Role | Access |
|---|---|
| `user` | Buy bandwidth, create proxy sessions, view usage/billing |
| `reseller` | Everything above + sub-user management, API keys, transfers |
| `admin` | Everything + all users, all orders, stock management |

API access is **reseller-only**. Regular users do not see API keys.

---

## File structure

```
gp/
├── app/
│   ├── page.tsx                      ← Landing page
│   ├── auth/{login,signup,reset...}  ← Auth flows
│   ├── dashboard/                    ← User dashboard
│   ├── reseller/                     ← Reseller panel
│   ├── admin/                        ← Admin panel
│   ├── api/
│   │   ├── checkout/                 ← Paystack initialization
│   │   ├── webhooks/paystack/        ← Payment webhook
│   │   ├── v1/                       ← Public REST API
│   │   └── admin/                    ← Admin API routes
│   ├── privacy/                      ← Privacy Policy
│   ├── terms/                        ← Terms of Service
│   └── refunds/                      ← Refund Policy
├── components/
│   ├── Navbar.tsx
│   ├── dashboard/{DashSidebar,DashTopbar}
│   ├── reseller/ResellerUsersList
│   └── admin/{AdminStockPanel,AdminUserControls,AdminResellerActions}
├── lib/
│   ├── supabase/{client,server}      ← Supabase clients
│   ├── paystack.ts                   ← Paystack helpers
│   ├── geonode.ts                    ← Proxy API wrapper
│   ├── bandwidth.ts                  ← Core activation engine
│   ├── email.ts                      ← Resend email
│   └── email-validation.ts           ← Blocks disposable emails
├── supabase/schema.sql               ← Full DB schema
├── middleware.ts                     ← Route protection
├── public/                           ← Favicons + OG image
└── .env.local.example
```
