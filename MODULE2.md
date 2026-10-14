# MODULE 2 — GST invoicing + quotations

Clean-room billing module: quotes → GST invoices → payments/receipts.
Built as additive code on the bizos fork — features and workflows
only, no third-party code, copy, or branding. Module 1 (social lead
capture) and all base functionality are untouched.

## What was built

**A. Data model** — `supabase/migrations/040_gst_billing.sql`

- `billing_settings` — per-account seller profile (name, GSTIN,
  2-digit state code, address) + numbering prefixes + strictly
  increasing counters. Numbers are never reused: counters only move
  forward, even across years.
- `quotes` / `quote_items` — status draft → sent → accepted /
  declined / expired. Totals denormalized (server-computed).
- `invoices` / `invoice_items` — status draft → issued →
  partially_paid → paid / overdue / cancelled. Per-line CGST/SGST/IGST
  are snapshotted at issue time, so an issued invoice never changes
  meaning if rules change later.
- `payments` — immutable money-in rows (no UPDATE policy); receipt
  numbers from the same per-account sequence.
- `next_billing_number(account, kind)` — SECURITY DEFINER RPC that
  locks the account's settings row, increments one counter, returns
  `PREFIX-YYYY-NNNN` (e.g. `INV-2026-0001`). Concurrent callers
  serialize on the row lock: no two documents ever share a number.
- RLS mirrors Module 1: members read; agent+ create/update (agents
  work deals); admin+ delete and void; settings are admin-writable.

**B. GST logic** — `src/lib/billing/gst.ts` (pure, fully unit-tested)

- Intra-state (seller state == place of supply) → CGST + SGST split
  evenly; inter-state → full IGST. Per-item rates 0/5/12/18/28.
- Integer paise everywhere; commercial half-up rounding **per line
  item**, then summed. On odd rates (e.g. 5% → 2.5 + 2.5), CGST takes
  half-up and SGST takes the remainder so the pair always sums
  exactly — never off by a paise.
- `quote → invoice` conversion: line economics carry over; GST is
  recomputed against the invoice's states at conversion time.

**C. API** — `src/app/api/billing/…`

- `quotes`: GET/POST, GET/PATCH/DELETE `[id]` (edits and deletes are
  draft-only), POST `[id]/send|accept|decline`, POST `[id]/convert`
  (accepted quote → draft invoice; the quote itself is never mutated).
- `invoices`: GET/POST, GET/PATCH/DELETE `[id]` (draft-only edits),
  POST `[id]/issue` (snapshots GST, stamps issued_at, defaults due
  date to +15 days), POST `[id]/void` (admin, unpaid only — a paid
  invoice must be resolved through payments, never voided).
- `[id]/payments`: GET/POST — records a payment with a sequential
  receipt number, recomputes `amount_paid`, flips status
  issued → partially_paid → paid. Overpayments are rejected (400).
- `settings`: GET/PUT — seller profile + prefixes (admin).
- Overdue is a read-time derivation: invoice reads flip
  issued/partially_paid past their due date to `overdue`
  (idempotent, no cron needed).
- Every write recomputes totals server-side from the items; client
  totals are never trusted.

**D. Admin UI** — `/billing` (sidebar: Billing)

- Quotes tab: list, create/edit dialog with live GST preview, send /
  accept / decline / convert-to-invoice actions.
- Invoices tab: list, create dialog (buyer, seller/place-of-supply
  state selects, due date), detail view with full GST breakdown
  (subtotal / CGST / SGST / IGST / total / paid / due), payment
  history, issue / void / record-payment actions.
- Payment receipts: printable receipt view (browser print,
  receipt-only print stylesheet) — no PDF library; a real PDF
  export is a later module if wanted.
- Light-first styling identical to Module 1 (warm paper `#FAF6EF`,
  white cards, one indigo accent).

## GST rules implemented (standard Indian GST mechanics)

1. CGST+SGST intra-state, IGST inter-state, place of supply as one
   2-digit state code per invoice (standard CBIC codes in
   `INDIAN_STATE_CODES`).
2. Per-line-item tax rates; invoice totals are the sum of rounded
   lines.
3. Sequential, never-reused document numbers per account.

## Deliberately out of scope (documented in `gst.ts`)

- GSTIN checksum/format validation — needs the government's API or
  the published checksum algorithm; fields exist, validation is a
  later module.
- Reverse-charge computation, composition scheme, e-invoicing
  (IRN/QR) — schema carries `reverse_charge`; computation not
  implemented.
- Mixed-supply invoices (different place of supply per line).
- Multi-currency — INR throughout v1 (schema has a `currency`
  column for later).

## Verified

- `tsc --noEmit` clean.
- `npm run build` succeeds — with one environment caveat: this
  sandbox has no Supabase credentials, so the build was run with
  dummy `NEXT_PUBLIC_SUPABASE_URL` / anon / service-role values.
  Without any Supabase env at all, the pre-existing base
  `/forgot-password` page fails at prerender (missing project URL —
  unrelated to Module 2; compilation and the TypeScript pass both
  succeed either way). The `/billing` page and all billing API
  routes are present in the production output.
- `npm test` (vitest): **872 passed / 83 files**, including 21 new
  GST tests — intra-state 18% split, inter-state IGST, odd-rate 5%
  split without losing a paise, fractional quantities, exempt 0%,
  per-line rounding, payment status transitions
  (issued → partially_paid → paid), overpayment clamping, rupee↔paise
  parsing, and `PREFIX-YYYY-NNNN` number formatting.

## Not verified (needs real services / data)

- The Supabase migration was syntax-checked, not applied to a live
  database (no Supabase project exists for this fork yet) — the
  `next_billing_number` RPC and RLS policies need a live apply to
  be proven end-to-end.
- Race-safety of numbering is by construction (row lock in the RPC)
  but untested under concurrent load.
- No real GSTINs were validated and no invoice was checked against
  actual Indian GST filing rules — the math follows standard
  mechanics, but a chartered accountant should review before this
  touches real filings.
- Receipt printing was not exercised in a real browser print flow
  (headless only).
