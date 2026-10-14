-- ============================================================
-- 031_social_lead_capture.sql — Module 1: social lead capture
--
-- One normalized lead stream fed by:
--   * HMAC-verified inbound webhooks from ad/directory/form providers
--     (Facebook Lead Ads, Justdial, website contact forms), and
--   * an Instagram comment-to-DM keyword trigger engine.
--
-- Tables
--   lead_sources  — one row per connected inbound source. `secret` is
--                   the per-source HMAC signing key, AES-256-GCM
--                   encrypted at rest (same `encrypt()`/`decrypt()` as
--                   `whatsapp_config.access_token`); returned to the
--                   creator exactly once so they can configure the
--                   provider's webhook secret. `verify_token` is the
--                   Meta hub.verify_token for the Instagram endpoint
--                   (also encrypted; only used for instagram sources).
--   leads         — the normalized lead stream: name / phone / email /
--                   source / campaign / status, plus the provider's raw
--                   payload in `raw_payload` for audit and re-mapping.
--   keyword_rules — Instagram comment-to-DM rules: a case-insensitive
--                   keyword (e.g. "PRICE") that, when found in a comment
--                   on the connected account, creates/finds a lead and
--                   queues a DM action.
--   lead_events   — append-only log of everything the capture layer
--                   does (lead captured, keyword matched, dm queued…).
--
-- RLS
--   Settings-class, mirroring `webhook_endpoints`: any member may read
--   the roster; only admin+ may create/update/delete. Ingestion runs
--   through the service-role client (the provider has no Supabase
--   session), so every inbound write is explicitly account-scoped in
--   the app layer.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS lead_sources (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  type             text NOT NULL CHECK (type IN ('facebook_lead_ads', 'justdial', 'web_form', 'instagram')),
  name             text NOT NULL,
  -- Per-source HMAC secret (plaintext returned once at creation; we
  -- need it at verify time, so it is stored encrypted, not hashed).
  secret           text NOT NULL,
  -- Meta hub.verify_token, instagram sources only. Encrypted at rest.
  verify_token     text,
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_sources_account_id_idx
  ON lead_sources (account_id);

CREATE TABLE IF NOT EXISTS leads (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_source_id   uuid REFERENCES lead_sources(id) ON DELETE SET NULL,
  name             text,
  phone            text,
  email            text,
  -- Denormalized provider label for fast filtering ('facebook_lead_ads',
  -- 'justdial', 'web_form', 'instagram').
  source           text NOT NULL,
  campaign         text,
  -- new → contacted → qualified → converted → lost
  status           text NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new', 'contacted', 'qualified', 'converted', 'lost')),
  raw_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_account_id_idx ON leads (account_id);
CREATE INDEX IF NOT EXISTS leads_account_created_idx
  ON leads (account_id, created_at DESC);
-- Phone dedup helper index: last-8-digit suffix matching mirrors the
-- contacts dedup strategy (see src/lib/contacts/dedupe.ts).
CREATE INDEX IF NOT EXISTS leads_account_phone_idx
  ON leads (account_id, phone);

CREATE TABLE IF NOT EXISTS keyword_rules (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Case-insensitive keyword; comment text is lower-cased before
  -- matching. One active rule per keyword per account.
  keyword          text NOT NULL,
  -- Reply template sent as the DM ({{name}} placeholder supported).
  -- Actual DM delivery is a stub until META_IG_* credentials are set —
  -- see src/lib/lead-capture/instagram.ts.
  reply_template   text NOT NULL DEFAULT 'Hi {{name}}! Thanks for your interest — we will DM you the details shortly.',
  is_active        boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, keyword)
);

CREATE INDEX IF NOT EXISTS keyword_rules_account_id_idx
  ON keyword_rules (account_id);

CREATE TABLE IF NOT EXISTS lead_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id          uuid REFERENCES leads(id) ON DELETE CASCADE,
  -- lead.captured | keyword.matched | dm.queued | dm.failed | lead.status_changed
  event_type       text NOT NULL,
  details          jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_events_account_id_idx
  ON lead_events (account_id);
CREATE INDEX IF NOT EXISTS lead_events_lead_id_idx
  ON lead_events (lead_id);
CREATE INDEX IF NOT EXISTS lead_events_account_created_idx
  ON lead_events (account_id, created_at DESC);

-- updated_at maintenance for leads (same trigger helper pattern as
-- other tables; defined here to keep the migration self-contained).
CREATE OR REPLACE FUNCTION public.touch_leads_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leads_touch_updated_at ON leads;
CREATE TRIGGER leads_touch_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION public.touch_leads_updated_at();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE lead_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_events ENABLE ROW LEVEL SECURITY;

-- lead_sources: settings-class (member read, admin+ write)
DROP POLICY IF EXISTS lead_sources_select ON lead_sources;
CREATE POLICY lead_sources_select ON lead_sources FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS lead_sources_insert ON lead_sources;
CREATE POLICY lead_sources_insert ON lead_sources FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS lead_sources_update ON lead_sources;
CREATE POLICY lead_sources_update ON lead_sources FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS lead_sources_delete ON lead_sources;
CREATE POLICY lead_sources_delete ON lead_sources FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- leads: any member reads; agent+ may insert/update (agents work
-- leads); only admin+ may delete.
DROP POLICY IF EXISTS leads_select ON leads;
CREATE POLICY leads_select ON leads FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS leads_insert ON leads;
CREATE POLICY leads_insert ON leads FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS leads_update ON leads;
CREATE POLICY leads_update ON leads FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS leads_delete ON leads;
CREATE POLICY leads_delete ON leads FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- keyword_rules: settings-class (member read, admin+ write)
DROP POLICY IF EXISTS keyword_rules_select ON keyword_rules;
CREATE POLICY keyword_rules_select ON keyword_rules FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS keyword_rules_insert ON keyword_rules;
CREATE POLICY keyword_rules_insert ON keyword_rules FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS keyword_rules_update ON keyword_rules;
CREATE POLICY keyword_rules_update ON keyword_rules FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS keyword_rules_delete ON keyword_rules;
CREATE POLICY keyword_rules_delete ON keyword_rules FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- lead_events: append-only log — members read; only the service role
-- (ingestion) writes. No dashboard INSERT policy by design.
DROP POLICY IF EXISTS lead_events_select ON lead_events;
CREATE POLICY lead_events_select ON lead_events FOR SELECT
  USING (is_account_member(account_id));
