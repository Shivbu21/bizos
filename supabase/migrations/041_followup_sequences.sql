-- ============================================================
-- 041_followup_sequences.sql — Module 3: drip follow-up sequencer
--
-- Clean-room follow-up engine (features/workflows only — no
-- third-party code, copy, or branding).
--
-- Tables
--   followup_sequences — named multi-step drip sequences owned by
--     an account. Per-sequence daily send cap, quiet hours window,
--     and timezone. active=false pauses the whole sequence.
--   sequence_steps — ordered steps of a sequence. day_offset is
--     days after enrollment (0 = same day). message_template
--     supports {{name}} and {{business}} variables. fallback is an
--     optional shorter variant used when the primary template is
--     unavailable (e.g. template not approved — caller decides).
--   sequence_enrollments — a contact's (optionally lead-linked)
--     journey through a sequence. Status:
--       active → next_due_at <= now means "send the current step".
--       paused → inbound reply arrived; a human is talking now.
--         Manual resume continues at the *next* step.
--       completed → all steps sent.
--       opted_out → contact sent STOP/UNSUBSCRIBE. Terminal: the
--         scheduler and the send path must never message these
--         contacts again.
--       cancelled → staff cancelled manually. Terminal.
--     Partial unique index keeps one active enrollment per
--     (sequence, contact); re-enrollment is allowed after the
--     previous journey ended.
--   followup_sends — append-only event log. Rows are written for
--     every send attempt (sent/failed) AND for lifecycle events
--     (enrolled, paused_on_reply, paused, resumed, opted_out,
--     completed, cancelled) with step_id NULL. Powers the
--     per-enrollment timeline. No UPDATE or DELETE policy by design.
--
-- Scheduling
--   next_due_at = enrolled_at + day_offset days, pushed past quiet
--   hours (see src/lib/followups/scheduler.ts). The cron route
--   claims a due enrollment by pushing next_due_at forward with a
--   conditional UPDATE (status='active' AND next_due_at <= now) so
--   overlapping cron invocations can't double-send.
--
-- RLS
--   Mirrors Module 1/2 conventions: members read everything;
--   agent+ manage sequences, steps, and enrollments (agents run
--   follow-ups); admin+ delete. followup_sends is read-only for
--   dashboards — only the service role writes it.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- Sequences
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS followup_sequences (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,
  active           boolean NOT NULL DEFAULT true,
  -- Max automated sends per account per calendar day (account's
  -- local date in the sequence timezone). 0 = no cap.
  daily_send_cap   int NOT NULL DEFAULT 50 CHECK (daily_send_cap >= 0),
  -- Quiet hours window in 'HH:MM' 24h format, evaluated in
  -- `timezone`. Sends are never scheduled inside the window;
  -- overnight windows (e.g. 21:00 → 09:00) are supported.
  quiet_start      text NOT NULL DEFAULT '21:00',
  quiet_end        text NOT NULL DEFAULT '09:00',
  timezone         text NOT NULL DEFAULT 'Asia/Kolkata',
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS followup_sequences_account_idx
  ON followup_sequences (account_id);
CREATE INDEX IF NOT EXISTS followup_sequences_account_active_idx
  ON followup_sequences (account_id, active);

-- ------------------------------------------------------------
-- Steps
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sequence_steps (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sequence_id      uuid NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  step_order       int NOT NULL CHECK (step_order >= 0),
  -- Days after enrollment this step becomes due. 0 = send on the
  -- first cron run after enrollment.
  day_offset       int NOT NULL CHECK (day_offset >= 0),
  channel          text NOT NULL DEFAULT 'whatsapp'
                   CHECK (channel IN ('whatsapp')),
  -- Supports {{name}} (contact name) and {{business}} (account name).
  message_template text NOT NULL,
  fallback         text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sequence_id, step_order)
);

CREATE INDEX IF NOT EXISTS sequence_steps_sequence_idx
  ON sequence_steps (sequence_id);

-- ------------------------------------------------------------
-- Enrollments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  sequence_id      uuid NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  -- Optional back-link to the Module 1 lead that started this.
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active', 'paused', 'completed', 'opted_out', 'cancelled')),
  -- Index into the sequence's ordered steps (0-based).
  current_step     int NOT NULL DEFAULT 0 CHECK (current_step >= 0),
  enrolled_at      timestamptz NOT NULL DEFAULT now(),
  next_due_at      timestamptz,
  last_sent_at     timestamptz,
  paused_at        timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sequence_enrollments_account_status_idx
  ON sequence_enrollments (account_id, status);
CREATE INDEX IF NOT EXISTS sequence_enrollments_due_idx
  ON sequence_enrollments (account_id, next_due_at)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS sequence_enrollments_contact_idx
  ON sequence_enrollments (contact_id);

-- One live journey per (sequence, contact). History is preserved
-- in followup_sends; re-enrollment after completion/opt-out is
-- allowed because the index only covers 'active' rows.
CREATE UNIQUE INDEX IF NOT EXISTS sequence_enrollments_one_active_idx
  ON sequence_enrollments (sequence_id, contact_id)
  WHERE status = 'active';

-- ------------------------------------------------------------
-- Send / event log (append-only)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS followup_sends (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  enrollment_id       uuid NOT NULL REFERENCES sequence_enrollments(id) ON DELETE CASCADE,
  step_id             uuid REFERENCES sequence_steps(id) ON DELETE SET NULL,
  status              text NOT NULL
                      CHECK (status IN (
                        'sent', 'failed',
                        'enrolled',
                        'paused_on_reply', 'paused', 'resumed',
                        'opted_out', 'completed', 'cancelled'
                      )),
  -- Meta's wamid for sent messages; null for lifecycle events.
  provider_message_id text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS followup_sends_enrollment_idx
  ON followup_sends (enrollment_id, created_at);
CREATE INDEX IF NOT EXISTS followup_sends_account_created_idx
  ON followup_sends (account_id, created_at DESC);

-- ------------------------------------------------------------
-- updated_at maintenance
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_followup_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS followup_sequences_touch_updated_at ON followup_sequences;
CREATE TRIGGER followup_sequences_touch_updated_at
  BEFORE UPDATE ON followup_sequences
  FOR EACH ROW EXECUTE FUNCTION public.touch_followup_updated_at();

DROP TRIGGER IF EXISTS sequence_enrollments_touch_updated_at ON sequence_enrollments;
CREATE TRIGGER sequence_enrollments_touch_updated_at
  BEFORE UPDATE ON sequence_enrollments
  FOR EACH ROW EXECUTE FUNCTION public.touch_followup_updated_at();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE followup_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE sequence_enrollments ENABLE ROW LEVEL SECURITY;
ALTER TABLE followup_sends ENABLE ROW LEVEL SECURITY;

-- followup_sequences: members read; agent+ manage; admin+ delete.
DROP POLICY IF EXISTS followup_sequences_select ON followup_sequences;
CREATE POLICY followup_sequences_select ON followup_sequences FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS followup_sequences_insert ON followup_sequences;
CREATE POLICY followup_sequences_insert ON followup_sequences FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS followup_sequences_update ON followup_sequences;
CREATE POLICY followup_sequences_update ON followup_sequences FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS followup_sequences_delete ON followup_sequences;
CREATE POLICY followup_sequences_delete ON followup_sequences FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- sequence_steps: same policy class as their parent sequence.
DROP POLICY IF EXISTS sequence_steps_select ON sequence_steps;
CREATE POLICY sequence_steps_select ON sequence_steps FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS sequence_steps_insert ON sequence_steps;
CREATE POLICY sequence_steps_insert ON sequence_steps FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS sequence_steps_update ON sequence_steps;
CREATE POLICY sequence_steps_update ON sequence_steps FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS sequence_steps_delete ON sequence_steps;
CREATE POLICY sequence_steps_delete ON sequence_steps FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- sequence_enrollments: members read; agent+ manage (agents run
-- follow-ups); admin+ delete.
DROP POLICY IF EXISTS sequence_enrollments_select ON sequence_enrollments;
CREATE POLICY sequence_enrollments_select ON sequence_enrollments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS sequence_enrollments_insert ON sequence_enrollments;
CREATE POLICY sequence_enrollments_insert ON sequence_enrollments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS sequence_enrollments_update ON sequence_enrollments;
CREATE POLICY sequence_enrollments_update ON sequence_enrollments FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS sequence_enrollments_delete ON sequence_enrollments;
CREATE POLICY sequence_enrollments_delete ON sequence_enrollments FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- followup_sends: members read; append-only — no INSERT/UPDATE/DELETE
-- policy for dashboards, so only the service role can write it.
DROP POLICY IF EXISTS followup_sends_select ON followup_sends;
CREATE POLICY followup_sends_select ON followup_sends FOR SELECT
  USING (is_account_member(account_id));
