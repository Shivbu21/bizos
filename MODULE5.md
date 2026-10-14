# MODULE 5 — Growth (continuous upsell loop)

**Status:** complete · 953 tests green (88 files, +21 new) · `tsc --noEmit` clean · `npm run build` ok

Module 5 closes the loop: dormant customers get won back, happy
customers are asked for reviews, happy customers bring friends, and
every lead gets a transparent score so follow-up effort goes where
it pays.

## What was built

| Piece | Where | Notes |
|---|---|---|
| Win-back automation | `src/lib/growth/winback.ts`, `dormancy.ts` (+tests) | Dormancy scan reuses the Module 3 sequence engine; enrollments logged in `followup_sends` |
| Review requests | `src/lib/growth/reviews.ts`, hook in billing payments POST, cron worker | Queued on invoice→paid; conditional-UPDATE claims prevent double-sends |
| Referrals | `src/lib/growth/referrals.ts`, `/api/growth/referrals/*`, ingest hook | 8-char unambiguous codes; contact detail shows code + referral count |
| Lead scoring (rules-based) | `src/lib/growth/scoring.ts` (+tests), `score-store.ts` | Pure `scoreLead()`; recompute on capture, inbound message, backfill |
| `/growth` page + sidebar | `src/app/(dashboard)/growth/page.tsx`, `sidebar.tsx`, EN+KO labels | Scores leaderboard, win-back settings, review settings + queue, referrals |
| Kind picker | follow-ups sequence dialog | Sequences can now be `drip` or `winback`; win-back badge on cards |
| Score badges | lead-sources leads table | Hot/warm/cold badges joined from cached scores |
| Migration | `supabase/migrations/043_growth_upsell.sql` | 5 tables, `kind` column, RLS policies |

## AI lead scoring — the auditable weights

Deliberately rules-based v1: no black box, no hidden model. Every
weight is a named constant in `src/lib/growth/scoring.ts`, the
breakdown is stored with every score, and this table is the contract.

| Signal | Weight | Details |
|---|---|---|
| **Source quality** | 25 max | whatsapp 25 · instagram 20 · facebook 18 · web_form 15 · justdial 12 · import/manual 8 · unknown 5 |
| **Engagement** | 30 max | 6+ inbound msgs 25 · 3–5 msgs 20 · 1–2 msgs 10 · +5 if last inbound within 7 days (capped at 30) |
| **Profile completeness** | 20 max | name 7 · phone 7 · email 6 |
| **Qualification stage** | 25 max | new 5 · contacted 12 · qualified 20 · converted 25 · lost 0 |

Bands: **hot ≥ 70**, **warm 40–69**, **cold < 40**. Scores live in
`lead_scores` (one row per lead, upserted on recompute). Recompute
triggers: new capture (ingest hook), inbound WhatsApp message
(webhook hook, matched by phone suffix), and the one-click backfill
(`POST /api/growth/scores/backfill`, agent+). Leads whose status is
changed elsewhere are caught by the next backfill or inbound event.

## Win-back scheduling rules

1. **Dormancy** — a contact is dormant when it has no invoice,
   payment, or inbound message for ≥ `winback_dormancy_days`
   (default 60). Last-activity = max(last inbound message, last
   invoice/payment, fallback `created_at`).
2. **Honest attribution limit** — invoices/payments link to *leads*,
   not contacts, so commercial activity is attributed through the
   contact↔lead links recorded by follow-up enrollments. A contact
   never linked to a lead is judged on messaging activity alone.
3. **Exclusions** — opted-out contacts are never enrolled; contacts
   with an active/paused journey are skipped; contacts win-backed
   (enrolled, opted out, or cancelled) within
   `winback_exclude_recent_days` (default 90) are skipped.
4. **Enrollment** — runs in the cron route after the drip worker;
   idempotent via exclusions + the partial unique index on active
   enrollments. Sends flow through the existing Module 3 engine, so
   quiet hours, daily caps, and reply-pause apply unchanged.
   Lifecycle events land in `followup_sends` (`enrolled` status).

## Review-request scheduling rules

- Queued when an invoice flips to `paid` (hook in the billing
  payments POST; best-effort, never breaks payment recording).
- `due_at = paid_at + review_delay_days` (default 2, 0–30).
- The cron worker claims due rows with a conditional UPDATE so
  overlapping ticks cannot double-send; failures are marked `failed`
  with the error, never silently dropped.
- Template supports `{{name}}` and `{{business}}`.

## Referrals

- One code per contact, 8 chars from an unambiguous alphabet
  (no 0/O, 1/I/L), unique per account (DB-enforced).
- `POST /api/growth/referrals` records a referral; self-referrals
  rejected (409); unknown codes rejected (404).
- New leads captured with a `referral_code` in the payload are
  logged automatically (case-insensitive key lookup).
- Contact detail view gained a Referrals tab (code + count).

## Honest verification limits

- **Migration not live-applied** — same standing caveat as prior
  modules: `043_growth_upsell.sql` is written and CI assertions were
  added to `supabase/ci/verify-schema.sql`, but it has not been run
  against a live Supabase project.
- **Review clicks are not tracked** — the send provider path has no
  click-callback support, so `sent` is the terminal observable state.
  This is stated in the UI, not hidden.
- **`scanWinback` / `processReviewRequests` have no unit tests** —
  they are DB- and provider-bound; the pure dormancy math and scoring
  math are fully covered (21 tests), the scan logic is exercised only
  in production via the cron route.
- **Attribution approximation** — invoice/payment activity is
  attributed to contacts via enrollment lead-links (see above); this
  is documented here rather than silently assumed.
- The `/forgot-password` prerender quirk from prior modules is
  unrelated and unchanged.
