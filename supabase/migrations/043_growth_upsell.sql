-- ============================================================
-- 043_growth_upsell.sql — Module 5: upsell loop + AI lead scoring
--
-- Clean-room growth module (features/workflows only — no
-- third-party code, copy, or branding).
--
-- Tables
--   growth_settings — per-account knobs for the upsell loop:
--     win-back (dormancy detection + winback sequence) and
--     post-invoice review requests (delay + template).
--   review_requests — due_at queue for review-request messages.
--     Rows are created when an invoice flips to paid; the cron
--     worker claims due rows, sends, and marks sent/failed.
--     Append-only by design (no UPDATE/DELETE policy).
--   referral_codes — one unique code per contact, auto-generated.
--   referrals — referrer_contact → referee lead/contact log.
--   lead_scores — cached 0–100 score + JSON breakdown per lead,
--     recomputed by the pure scorer in src/lib/growth/scoring.ts.
--
-- Reuse
--   Win-back reuses the Module 3 sequence engine: a win-back
--   sequence is a normal followup_sequences row with kind='winback';
--   dormant contacts are enrolled as sequence_enrollments and the
--   existing cron worker sends the steps. Review requests reuse the
--   cron route + the base template's engineSendText.
--
-- RLS
--   Mirrors Module 1–4 conventions: members read everything;
--   agent+ manage; admin+ delete; settings are admin-writable.
--   review_requests is read-only for dashboards — only the
--   service role writes it (created by the payment hook, updated
--   by the cron worker).
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- Sequence kind (drip vs winback)
-- ------------------------------------------------------------
ALTER TABLE followup_sequences
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'drip'
    CHECK (kind IN ('drip', 'winback'));

-- ------------------------------------------------------------
-- Growth settings (one row per account)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS growth_settings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  -- Win-back
  winback_enabled         boolean NOT NULL DEFAULT false,
  winback_dormancy_days   int NOT NULL DEFAULT 60 CHECK (winback_dormancy_days >= 7),
  winback_sequence_id     uuid REFERENCES followup_sequences(id) ON DELETE SET NULL,
  -- Don't re-nag: skip contacts enrolled/opted-out in the last N days
  winback_exclude_recent_days int NOT NULL DEFAULT 90 CHECK (winback_exclude_recent_days >= 0),
  -- Post-invoice review requests
  review_enabled          boolean NOT NULL DEFAULT false,
  review_delay_days       int NOT NULL DEFAULT 2 CHECK (review_delay_days >= 0),
  review_template         text NOT NULL DEFAULT 'Hi {{name}}, thanks for your business! If you had a great experience, a quick review would mean a lot to us.',
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------
-- Review requests (due_at queue)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id          uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  invoice_id          uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  due_at              timestamptz NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed')),
  message_snapshot    text,
  sent_at             timestamptz,
  provider_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS review_requests_due_idx
  ON review_requests (account_id, status, due_at);
-- One review request per paid invoice — never double-ask.
CREATE UNIQUE INDEX IF NOT EXISTS review_requests_invoice_unique
  ON review_requests (account_id, invoice_id);

-- ------------------------------------------------------------
-- Referral codes + referrals log
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS referral_codes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  code       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_codes_account_contact_unique UNIQUE (account_id, contact_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_code_unique
  ON referral_codes (account_id, code);

CREATE TABLE IF NOT EXISTS referrals (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  referrer_contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  referee_lead_id     uuid REFERENCES leads(id) ON DELETE SET NULL,
  referee_contact_id  uuid REFERENCES contacts(id) ON DELETE SET NULL,
  code                text NOT NULL,
  status              text NOT NULL DEFAULT 'recorded'
                        CHECK (status IN ('recorded', 'converted', 'rewarded')),
  reward_note         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referrals_referee_present CHECK (
    referee_lead_id IS NOT NULL OR referee_contact_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS referrals_referrer_idx
  ON referrals (account_id, referrer_contact_id);
CREATE INDEX IF NOT EXISTS referrals_code_idx
  ON referrals (account_id, code);

-- ------------------------------------------------------------
-- Lead scores (cached, recomputed by the scorer)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS lead_scores (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  lead_id    uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  score      int NOT NULL CHECK (score >= 0 AND score <= 100),
  breakdown  jsonb NOT NULL DEFAULT '{}'::jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lead_scores_account_lead_unique UNIQUE (account_id, lead_id)
);

CREATE INDEX IF NOT EXISTS lead_scores_account_score_idx
  ON lead_scores (account_id, score DESC);

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE growth_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scores ENABLE ROW LEVEL SECURITY;

-- growth_settings: members read; admin+ write (knobs, not daily ops).
CREATE POLICY growth_settings_select ON growth_settings FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY growth_settings_insert ON growth_settings FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY growth_settings_update ON growth_settings FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY growth_settings_delete ON growth_settings FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- review_requests: read-only for dashboards; service role writes.
CREATE POLICY review_requests_select ON review_requests FOR SELECT
  USING (is_account_member(account_id));

-- referral_codes: members read; agent+ manage.
CREATE POLICY referral_codes_select ON referral_codes FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY referral_codes_insert ON referral_codes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY referral_codes_update ON referral_codes FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY referral_codes_delete ON referral_codes FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- referrals: members read; agent+ manage.
CREATE POLICY referrals_select ON referrals FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY referrals_insert ON referrals FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY referrals_update ON referrals FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY referrals_delete ON referrals FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- lead_scores: members read; service role + agent+ write
-- (recomputed by the scorer, backfilled by staff).
CREATE POLICY lead_scores_select ON lead_scores FOR SELECT
  USING (is_account_member(account_id));
CREATE POLICY lead_scores_insert ON lead_scores FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
CREATE POLICY lead_scores_update ON lead_scores FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
CREATE POLICY lead_scores_delete ON lead_scores FOR DELETE
  USING (is_account_member(account_id, 'admin'));
