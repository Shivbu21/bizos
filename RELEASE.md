# bizos 1.0.0 — Release Notes

**Build date:** 2026-10-14
**License:** MIT (see LICENSE; fork of geekcheng/wacrm with attribution)
**Codename:** bizos (working name — not final branding)

## What it is

An open-source AI business OS / CRM for small businesses: WhatsApp inbox with
pipeline and automation, social lead capture, GST billing, drip follow-ups, work
execution boards, attendance, and a growth loop with AI lead scoring.

## Verified this release

- `npm run build` (Next.js 16 production build, dummy Supabase env) — succeeds,
  all routes present (`/growth`, `/follow-ups`, `/lead-sources`, `/work`, …)
- `npm test` (vitest) — **953/953 pass** (88 files)
- `tsc --noEmit` — clean

## Modules included

1. **Social lead capture** — Facebook Lead Ads, Justdial, web-form webhooks
   (HMAC-verified) normalized into one lead stream; Instagram comment keyword
   triggers (DM send stubbed)
2. **GST billing** — quotes → invoices → payments/receipts; integer-paise
   CGST/SGST/IGST math; race-safe sequential numbering; partial payments
3. **Drip follow-ups** — sequences/steps/enrollments, quiet hours (21:00–09:00
   Asia/Kolkata default), daily caps, STOP handling, secret-protected cron route
4. **Work execution + attendance** — kanban boards with drag/drop, card comments,
   lead/invoice links; attendance check-in/out + admin corrections; tasks
5. **Growth loop** — win-back automation for dormant customers, post-invoice
   review requests, referrals with unique codes, transparent rules-based AI lead
   scoring (0–100, documented weights) with leaderboard

Base (wacrm) provides: WhatsApp inbox, visual pipeline, automation flows, AI
qualification, contacts, dashboard.

## Run it

```bash
cd bizos-1.0.0
npm install   # or npm ci
# create a Supabase project, apply supabase/migrations/*.sql in order, then:
cp .env.local.example .env.local   # fill in your Supabase + Meta/WhatsApp keys
npm run dev
```

Deploy: Vercel (`npm run build` verified) + Supabase. Apply migrations
`031` → `043` in order on first setup.

## Going live — required

- **Supabase** project (database + auth); apply all migrations
- **Meta/WhatsApp** credentials for messaging + Instagram triggers
- A scheduler hitting `POST /api/cron/followups` with the cron secret

## Honest limitations

- Migrations have **not** been applied to a live Supabase project — first deploy
  must run them in order
- No live Meta/WhatsApp credentials were available: webhooks and live sends are
  code-verified only; Instagram DM sending is an intentional stub
- **GST implementation needs a chartered accountant's review** before real filing
  use; GSTIN validation is stubbed; no e-invoicing/IRN
- No live concurrency/load test of the invoice-numbering RPC
- Exact production Justdial webhook payload remains unverified
