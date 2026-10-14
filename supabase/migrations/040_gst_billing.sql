-- ============================================================
-- 040_gst_billing.sql — Module 2: GST invoicing + quotations
--
-- Clean-room billing module (features/workflows only — no
-- third-party code, copy, or branding).
--
-- Tables
--   billing_settings — per-account seller profile (name, GSTIN,
--     state code, address) + numbering prefixes + strictly
--     increasing sequence counters. Numbers are NEVER reused:
--     counters only move forward, even across financial years.
--   quotes / quote_items — quotations with line items. Status:
--     draft → sent → accepted | declined | expired.
--   invoices / invoice_items — GST invoices. Status:
--     draft → issued → partially_paid → paid | overdue | cancelled.
--     Per-line CGST/SGST/IGST are snapshotted at issue time so an
--     issued invoice never changes meaning if tax rules change.
--   payments — money received against an invoice. Immutable in the
--     UI (no UPDATE policy); a mistaken payment is deleted by an
--     admin and the invoice's paid total is recomputed.
--
-- Money rule: integer paise in EVERY money column. No floats,
-- no numeric money columns. GST is split per line item in the
-- app layer (src/lib/billing/gst.ts); the DB stores the results.
--
-- Numbering
--   next_billing_number(account_id, kind) is SECURITY DEFINER with
--   a fixed search_path: it locks the account's settings row
--   (INSERT … ON CONFLICT DO NOTHING, then UPDATE), increments the
--   right counter, and returns PREFIX-YYYY-NNNN (e.g. INV-2026-0001).
--   EXECUTE is granted to `authenticated` only; the API routes
--   still gate with requireRole('agent') before calling it.
--
-- RLS
--   Mirrors Module 1 conventions: members read everything; agent+
--   may create/update quotes, invoices, and payments (agents work
--   deals); only admin+ may delete or edit billing settings.
--   Item tables inherit their parent document's policy class.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- Per-account settings + numbering
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_settings (
  account_id       uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  -- Seller profile, prefilled onto new invoices (editable per invoice).
  seller_name      text,
  seller_gstin     text,
  -- 2-digit GST state code of the seller (e.g. '07' = Delhi).
  seller_state_code text,
  seller_address   text,
  -- Number prefixes.
  quote_prefix     text NOT NULL DEFAULT 'QT',
  invoice_prefix   text NOT NULL DEFAULT 'INV',
  receipt_prefix   text NOT NULL DEFAULT 'RCP',
  -- Strictly increasing counters. Never reset, never reused.
  quote_seq        bigint NOT NULL DEFAULT 0,
  invoice_seq      bigint NOT NULL DEFAULT 0,
  receipt_seq      bigint NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.next_billing_number(
  p_account_id uuid,
  p_kind text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_seq    bigint;
  v_prefix text;
BEGIN
  IF p_kind NOT IN ('quote', 'invoice', 'receipt') THEN
    RAISE EXCEPTION 'invalid billing number kind: %', p_kind;
  END IF;

  -- Ensure the row exists, then lock + increment. The UPDATE takes a
  -- row lock, so concurrent callers serialize and each gets a unique
  -- number — no two documents ever share one.
  INSERT INTO billing_settings (account_id)
  VALUES (p_account_id)
  ON CONFLICT (account_id) DO NOTHING;

  IF p_kind = 'quote' THEN
    UPDATE billing_settings
    SET quote_seq = quote_seq + 1, updated_at = now()
    WHERE account_id = p_account_id
    RETURNING quote_seq, quote_prefix INTO v_seq, v_prefix;
  ELSIF p_kind = 'invoice' THEN
    UPDATE billing_settings
    SET invoice_seq = invoice_seq + 1, updated_at = now()
    WHERE account_id = p_account_id
    RETURNING invoice_seq, invoice_prefix INTO v_seq, v_prefix;
  ELSE
    UPDATE billing_settings
    SET receipt_seq = receipt_seq + 1, updated_at = now()
    WHERE account_id = p_account_id
    RETURNING receipt_seq, receipt_prefix INTO v_seq, v_prefix;
  END IF;

  RETURN v_prefix || '-' || to_char(now(), 'YYYY') || '-' || lpad(v_seq::text, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_billing_number(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_billing_number(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- Quotes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number           text NOT NULL,
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  customer_name    text NOT NULL,
  customer_email   text,
  customer_phone   text,
  customer_address text,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
  valid_until      date,
  notes            text,
  currency         text NOT NULL DEFAULT 'INR',
  -- Denormalized totals (recomputed server-side on every write).
  subtotal_paise   bigint NOT NULL DEFAULT 0,
  tax_paise        bigint NOT NULL DEFAULT 0,
  total_paise      bigint NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, number)
);

CREATE INDEX IF NOT EXISTS quotes_account_id_idx ON quotes (account_id);
CREATE INDEX IF NOT EXISTS quotes_account_status_idx ON quotes (account_id, status);

CREATE TABLE IF NOT EXISTS quote_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  quote_id           uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  description        text NOT NULL,
  quantity           numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Integer paise. GST rate as a plain number (0, 5, 12, 18, 28…).
  rate_paise         bigint NOT NULL CHECK (rate_paise >= 0),
  gst_rate           numeric NOT NULL DEFAULT 18 CHECK (gst_rate >= 0 AND gst_rate <= 28),
  line_taxable_paise bigint NOT NULL DEFAULT 0,
  line_tax_paise     bigint NOT NULL DEFAULT 0,
  line_total_paise   bigint NOT NULL DEFAULT 0,
  position           int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS quote_items_quote_id_idx ON quote_items (quote_id);

-- ------------------------------------------------------------
-- Invoices
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  number           text NOT NULL,
  quote_id         uuid REFERENCES quotes(id) ON DELETE SET NULL,
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'cancelled')),
  -- Seller snapshot (prefilled from billing_settings at creation).
  seller_name       text,
  seller_gstin      text,
  seller_state_code text,
  seller_address    text,
  -- Buyer.
  buyer_name        text NOT NULL,
  buyer_gstin       text,
  buyer_address     text,
  -- 2-digit GST state code of the place of supply. When it equals
  -- seller_state_code the supply is intra-state (CGST+SGST),
  -- otherwise inter-state (IGST). See src/lib/billing/gst.ts.
  place_of_supply   text,
  reverse_charge     boolean NOT NULL DEFAULT false,
  currency           text NOT NULL DEFAULT 'INR',
  -- Denormalized totals (recomputed server-side on every write).
  subtotal_paise     bigint NOT NULL DEFAULT 0,
  cgst_paise         bigint NOT NULL DEFAULT 0,
  sgst_paise         bigint NOT NULL DEFAULT 0,
  igst_paise         bigint NOT NULL DEFAULT 0,
  total_paise        bigint NOT NULL DEFAULT 0,
  amount_paid_paise  bigint NOT NULL DEFAULT 0,
  issued_at          timestamptz,
  due_at             date,
  notes              text,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, number)
);

CREATE INDEX IF NOT EXISTS invoices_account_id_idx ON invoices (account_id);
CREATE INDEX IF NOT EXISTS invoices_account_status_idx ON invoices (account_id, status);
CREATE INDEX IF NOT EXISTS invoices_account_due_idx ON invoices (account_id, due_at);

CREATE TABLE IF NOT EXISTS invoice_items (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invoice_id         uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description        text NOT NULL,
  quantity           numeric NOT NULL DEFAULT 1 CHECK (quantity > 0),
  rate_paise         bigint NOT NULL CHECK (rate_paise >= 0),
  gst_rate           numeric NOT NULL DEFAULT 18 CHECK (gst_rate >= 0 AND gst_rate <= 28),
  line_taxable_paise bigint NOT NULL DEFAULT 0,
  line_cgst_paise    bigint NOT NULL DEFAULT 0,
  line_sgst_paise    bigint NOT NULL DEFAULT 0,
  line_igst_paise    bigint NOT NULL DEFAULT 0,
  line_total_paise   bigint NOT NULL DEFAULT 0,
  position           int NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS invoice_items_invoice_id_idx ON invoice_items (invoice_id);

-- ------------------------------------------------------------
-- Payments
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  invoice_id       uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  receipt_number   text NOT NULL,
  amount_paise     bigint NOT NULL CHECK (amount_paise > 0),
  method           text NOT NULL
                   CHECK (method IN ('cash', 'upi', 'bank_transfer', 'card', 'other')),
  reference        text,
  received_at      date NOT NULL DEFAULT CURRENT_DATE,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, receipt_number)
);

CREATE INDEX IF NOT EXISTS payments_invoice_id_idx ON payments (invoice_id);
CREATE INDEX IF NOT EXISTS payments_account_created_idx
  ON payments (account_id, created_at DESC);

-- ------------------------------------------------------------
-- updated_at maintenance
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_billing_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS quotes_touch_updated_at ON quotes;
CREATE TRIGGER quotes_touch_updated_at
  BEFORE UPDATE ON quotes
  FOR EACH ROW EXECUTE FUNCTION public.touch_billing_updated_at();

DROP TRIGGER IF EXISTS invoices_touch_updated_at ON invoices;
CREATE TRIGGER invoices_touch_updated_at
  BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION public.touch_billing_updated_at();

DROP TRIGGER IF EXISTS billing_settings_touch_updated_at ON billing_settings;
CREATE TRIGGER billing_settings_touch_updated_at
  BEFORE UPDATE ON billing_settings
  FOR EACH ROW EXECUTE FUNCTION public.touch_billing_updated_at();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE billing_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

-- billing_settings: settings-class — members read, admin+ write.
-- Counter increments go through next_billing_number() only.
DROP POLICY IF EXISTS billing_settings_select ON billing_settings;
CREATE POLICY billing_settings_select ON billing_settings FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS billing_settings_upsert ON billing_settings;
CREATE POLICY billing_settings_upsert ON billing_settings FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- quotes: members read; agent+ write; admin+ delete.
DROP POLICY IF EXISTS quotes_select ON quotes;
CREATE POLICY quotes_select ON quotes FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS quotes_insert ON quotes;
CREATE POLICY quotes_insert ON quotes FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS quotes_update ON quotes;
CREATE POLICY quotes_update ON quotes FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS quotes_delete ON quotes;
CREATE POLICY quotes_delete ON quotes FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- quote_items: inherits the quote's policy class.
DROP POLICY IF EXISTS quote_items_select ON quote_items;
CREATE POLICY quote_items_select ON quote_items FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS quote_items_insert ON quote_items;
CREATE POLICY quote_items_insert ON quote_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS quote_items_update ON quote_items;
CREATE POLICY quote_items_update ON quote_items FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS quote_items_delete ON quote_items;
CREATE POLICY quote_items_delete ON quote_items FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- invoices: members read; agent+ write; admin+ delete.
DROP POLICY IF EXISTS invoices_select ON invoices;
CREATE POLICY invoices_select ON invoices FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS invoices_insert ON invoices;
CREATE POLICY invoices_insert ON invoices FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS invoices_update ON invoices;
CREATE POLICY invoices_update ON invoices FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS invoices_delete ON invoices;
CREATE POLICY invoices_delete ON invoices FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- invoice_items: inherits the invoice's policy class.
DROP POLICY IF EXISTS invoice_items_select ON invoice_items;
CREATE POLICY invoice_items_select ON invoice_items FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS invoice_items_insert ON invoice_items;
CREATE POLICY invoice_items_insert ON invoice_items FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS invoice_items_update ON invoice_items;
CREATE POLICY invoice_items_update ON invoice_items FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS invoice_items_delete ON invoice_items;
CREATE POLICY invoice_items_delete ON invoice_items FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- payments: members read; agent+ may record (insert); payments are
-- immutable (no UPDATE policy — a mistaken payment is deleted by an
-- admin and the invoice's paid total is recomputed by the API).
DROP POLICY IF EXISTS payments_select ON payments;
CREATE POLICY payments_select ON payments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS payments_insert ON payments;
CREATE POLICY payments_insert ON payments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS payments_delete ON payments;
CREATE POLICY payments_delete ON payments FOR DELETE
  USING (is_account_member(account_id, 'admin'));
