# MODULE 1 — Social lead capture

One normalized lead stream fed by two capture paths. Built as clean-room
code on the bizos fork — features and workflows only, no third-party
code, copy, or branding.

## What was built

**A. Generic inbound webhook** — `POST /api/lead-capture/webhook?source=<id>`

- Paste the URL into Facebook Lead Ads / Justdial / your website form's
  webhook settings. Each provider posts its native payload.
- The provider signs with `X-Signature: sha256=<hex>` (bare hex also
  accepted), verified against the per-source HMAC secret with a
  constant-time compare. Bad signature → 401; unknown/paused source → 404.
- Payloads are normalized per provider
  (`src/lib/lead-capture/normalize.ts`) into name/phone/email/campaign;
  the raw body is always kept in `leads.raw_payload` for audit.
- Ingestion runs in `after()` so the provider gets its 200 immediately.

**B. Instagram comment-to-DM triggers** — `/api/lead-capture/instagram?source=<id>`

- `GET` answers Meta's hub verification handshake (hub.verify_token is
  matched against the source's encrypted verify token).
- `POST` verifies `x-hub-signature-256` with `META_APP_SECRET`, extracts
  comment events, and runs each through the account's active keyword
  rules (case-insensitive substring, e.g. comment contains "PRICE").
- On a hit: find-or-create lead → log `keyword.matched` → queue DM reply.
- **DM delivery is a stub.** Comment capture, keyword matching, lead
  creation, and event logging all work without Meta credentials. To send
  real DMs, set `META_IG_PAGE_ID` + `META_IG_PAGE_ACCESS_TOKEN` and
  implement the Graph POST where `queueDmAction()` is marked
  (`src/lib/lead-capture/instagram.ts`).

**C. Data model** — `supabase/migrations/031_social_lead_capture.sql`

- `lead_sources` — connected providers; secrets/verify tokens AES-256-GCM
  encrypted at rest, returned plaintext exactly once at creation.
- `leads` — name, phone, email, source, campaign, status
  (`new → contacted → qualified → converted → lost`), `raw_payload JSONB`.
  Phone dedup by last-8-digit suffix; repeats log `lead.recaptured`.
- `keyword_rules` — one active rule per keyword per account; reply
  templates support `{{name}}`.
- `lead_events` — append-only log (`lead.captured`, `keyword.matched`,
  `dm.queued`, …). No dashboard write policy by design.
- RLS on all four tables: members read; admin+ manage sources/rules;
  agents may work leads; only the service role writes events.

**D. Admin UI** — `/lead-sources` (sidebar: Lead Sources)

- Source cards with copyable webhook URLs, pause toggles, one-time
  secret display, and secret regeneration; keyword rule CRUD table;
  recent captured leads table. Mutations are admin-gated
  (`useCan("edit-settings")`).
- Light-first premium styling per the standing UI preference: warm
  paper background, white cards, one confident indigo accent —
  explicit colors so the page renders light regardless of app theme.
  The base template itself is untouched.

## Configure it

1. Copy `.env.local.example` → `.env.local`, run migrations 001–031.
2. Open Lead Sources → Add source (pick provider, name it).
3. Copy the webhook URL into the provider's dashboard; copy the
   one-time HMAC secret into the provider's webhook-secret field.
4. For Instagram: create an `instagram` source, note the verify token,
   subscribe `https://<host>/api/lead-capture/instagram?source=<id>` in
   the Meta App Dashboard → Webhooks → instagram, add keyword rules.

## Verified

- `tsc --noEmit` clean; `npm run build` succeeds; `npm test` (vitest)
  passes, including new unit tests for HMAC verification, payload
  normalization, and the comment/keyword engine.

## Not verified (needs real credentials / services)

- Live Meta webhook deliveries (Facebook Lead Ads, Instagram comments)
  — endpoints, verification, and HMAC paths are implemented and unit
  tested, but no real Meta app was pointed at them.
- Actual Instagram DM sending — intentionally a stub (see above).
- The Supabase migration was syntax-checked, not applied to a live
  database (no Supabase project exists for this fork yet).
- Justdial's exact production payload shape — the normalizer is
  defensive (case-insensitive key lookup, graceful nulls) but was
  tested against representative, not live, payloads.
