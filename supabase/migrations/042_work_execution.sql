-- ============================================================
-- 042_work_execution.sql — Module 4: work-execution stage
-- (kanban boards + attendance + tasks)
--
-- Clean-room work-execution module (features/workflows only — no
-- third-party code, copy, or branding). Additive: Modules 1–3 and
-- all base functionality are untouched.
--
-- Tables
--   work_boards      — named kanban boards owned by an account
--                      (e.g. "Client delivery", "Website builds").
--   board_columns    — columns of a board; position orders them
--                      left-to-right. is_done marks "Done"-style
--                      columns (used for the overdue derivation).
--                      The board-create API seeds
--                      "To do" / "In progress" / "Done".
--   work_cards       — cards on a column; position is a fractional
--                      numeric so drag-drop reorders without
--                      renumbering siblings (see
--                      src/lib/work/kanban.ts). Optional back-links
--                      to a Module-1 lead and a Module-2 invoice.
--   card_comments    — append-only comment log per card. No
--                      UPDATE/DELETE policy by design.
--   attendance_records — one row per (account, user, day), enforced
--                      by a unique index. status is
--                      present / absent / half_day / leave.
--                      check_in_at / check_out_at are wall-clock
--                      instants; notes for corrections.
--   tasks            — lightweight to-dos with an assignee, due
--                      date, and an optional reminder_at. done flips
--                      with done_at stamped.
--
-- RLS
--   Mirrors Modules 1–3: members read everything; agent+ manage
--   boards/columns/cards/tasks (agents execute work); admin+ delete.
--   Attendance: members read the roster's records and manage their
--   OWN row (self check-in); only admin+ may mark or correct
--   another member's row. card_comments are append-only —
--   dashboards read, agent+ insert, no update/delete policy.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ------------------------------------------------------------
-- Boards
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_boards (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name        text NOT NULL,
  description text,
  created_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_boards_account_idx
  ON work_boards (account_id);

-- ------------------------------------------------------------
-- Columns
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS board_columns (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  board_id   uuid NOT NULL REFERENCES work_boards(id) ON DELETE CASCADE,
  name       text NOT NULL,
  position   int NOT NULL DEFAULT 0,
  -- True for "Done"-style columns: cards sitting here are excluded
  -- from the overdue derivation.
  is_done    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS board_columns_board_idx
  ON board_columns (board_id, position);

-- ------------------------------------------------------------
-- Cards
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS work_cards (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  board_id         uuid NOT NULL REFERENCES work_boards(id) ON DELETE CASCADE,
  column_id        uuid NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  assignee_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_date         date,
  -- Fractional ordering: a card dropped between positions a and b
  -- takes (a+b)/2. Large initial gaps (1024) mean rebalances are
  -- rare; needsRebalance() in the kanban lib detects tight gaps.
  position         numeric NOT NULL DEFAULT 1024,
  -- Optional back-links into the earlier modules' pipeline.
  lead_id          uuid REFERENCES leads(id) ON DELETE SET NULL,
  invoice_id       uuid REFERENCES invoices(id) ON DELETE SET NULL,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS work_cards_column_idx
  ON work_cards (column_id, position);
CREATE INDEX IF NOT EXISTS work_cards_board_idx
  ON work_cards (board_id);
CREATE INDEX IF NOT EXISTS work_cards_assignee_idx
  ON work_cards (assignee_user_id)
  WHERE assignee_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS work_cards_due_idx
  ON work_cards (account_id, due_date)
  WHERE due_date IS NOT NULL;

-- ------------------------------------------------------------
-- Card comments (append-only)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS card_comments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  card_id        uuid NOT NULL REFERENCES work_cards(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  body           text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS card_comments_card_idx
  ON card_comments (card_id, created_at);

-- ------------------------------------------------------------
-- Attendance
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance_records (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date         date NOT NULL,
  status       text NOT NULL DEFAULT 'present'
               CHECK (status IN ('present', 'absent', 'half_day', 'leave')),
  check_in_at  timestamptz,
  check_out_at timestamptz,
  notes        text,
  created_by   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (check_out_at IS NULL OR check_in_at IS NULL OR check_out_at >= check_in_at)
);

-- One row per (account, user, day) — the upsert key the API uses
-- for check-in/check-out.
CREATE UNIQUE INDEX IF NOT EXISTS attendance_records_one_per_day_idx
  ON attendance_records (account_id, user_id, date);

CREATE INDEX IF NOT EXISTS attendance_records_account_date_idx
  ON attendance_records (account_id, date);

-- ------------------------------------------------------------
-- Tasks
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  title            text NOT NULL,
  description      text,
  assignee_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  due_at           timestamptz,
  done             boolean NOT NULL DEFAULT false,
  done_at          timestamptz,
  -- Optional nudge time; the UI surfaces tasks whose reminder_at
  -- is past and which are still open.
  reminder_at      timestamptz,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_account_idx
  ON tasks (account_id, done, due_at);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx
  ON tasks (assignee_user_id)
  WHERE assignee_user_id IS NOT NULL;

-- ------------------------------------------------------------
-- updated_at maintenance
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.touch_work_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS work_boards_touch_updated_at ON work_boards;
CREATE TRIGGER work_boards_touch_updated_at
  BEFORE UPDATE ON work_boards
  FOR EACH ROW EXECUTE FUNCTION public.touch_work_updated_at();

DROP TRIGGER IF EXISTS work_cards_touch_updated_at ON work_cards;
CREATE TRIGGER work_cards_touch_updated_at
  BEFORE UPDATE ON work_cards
  FOR EACH ROW EXECUTE FUNCTION public.touch_work_updated_at();

DROP TRIGGER IF EXISTS attendance_records_touch_updated_at ON attendance_records;
CREATE TRIGGER attendance_records_touch_updated_at
  BEFORE UPDATE ON attendance_records
  FOR EACH ROW EXECUTE FUNCTION public.touch_work_updated_at();

DROP TRIGGER IF EXISTS tasks_touch_updated_at ON tasks;
CREATE TRIGGER tasks_touch_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION public.touch_work_updated_at();

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE work_boards ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_columns ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE card_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- work_boards: members read; agent+ manage; admin+ delete.
DROP POLICY IF EXISTS work_boards_select ON work_boards;
CREATE POLICY work_boards_select ON work_boards FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS work_boards_insert ON work_boards;
CREATE POLICY work_boards_insert ON work_boards FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS work_boards_update ON work_boards;
CREATE POLICY work_boards_update ON work_boards FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS work_boards_delete ON work_boards;
CREATE POLICY work_boards_delete ON work_boards FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- board_columns: same policy class as their parent board.
DROP POLICY IF EXISTS board_columns_select ON board_columns;
CREATE POLICY board_columns_select ON board_columns FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS board_columns_insert ON board_columns;
CREATE POLICY board_columns_insert ON board_columns FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS board_columns_update ON board_columns;
CREATE POLICY board_columns_update ON board_columns FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS board_columns_delete ON board_columns;
CREATE POLICY board_columns_delete ON board_columns FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- work_cards: members read; agent+ manage; admin+ delete.
DROP POLICY IF EXISTS work_cards_select ON work_cards;
CREATE POLICY work_cards_select ON work_cards FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS work_cards_insert ON work_cards;
CREATE POLICY work_cards_insert ON work_cards FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS work_cards_update ON work_cards;
CREATE POLICY work_cards_update ON work_cards FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS work_cards_delete ON work_cards;
CREATE POLICY work_cards_delete ON work_cards FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- card_comments: members read; agent+ insert; append-only — no
-- UPDATE or DELETE policy, so only the service role can change it.
DROP POLICY IF EXISTS card_comments_select ON card_comments;
CREATE POLICY card_comments_select ON card_comments FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS card_comments_insert ON card_comments;
CREATE POLICY card_comments_insert ON card_comments FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

-- attendance_records: members read the whole roster; a member may
-- insert/update their OWN row (self check-in); only admin+ may
-- touch another member's row. Deleting a row is admin+ only.
DROP POLICY IF EXISTS attendance_records_select ON attendance_records;
CREATE POLICY attendance_records_select ON attendance_records FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS attendance_records_insert ON attendance_records;
CREATE POLICY attendance_records_insert ON attendance_records FOR INSERT
  WITH CHECK (
    is_account_member(account_id)
    AND (
      user_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );

DROP POLICY IF EXISTS attendance_records_update ON attendance_records;
CREATE POLICY attendance_records_update ON attendance_records FOR UPDATE
  USING (
    is_account_member(account_id)
    AND (
      user_id = auth.uid()
      OR is_account_member(account_id, 'admin')
    )
  );

DROP POLICY IF EXISTS attendance_records_delete ON attendance_records;
CREATE POLICY attendance_records_delete ON attendance_records FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- tasks: members read; agent+ manage; admin+ delete.
DROP POLICY IF EXISTS tasks_select ON tasks;
CREATE POLICY tasks_select ON tasks FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS tasks_insert ON tasks;
CREATE POLICY tasks_insert ON tasks FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS tasks_update ON tasks;
CREATE POLICY tasks_update ON tasks FOR UPDATE
  USING (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS tasks_delete ON tasks;
CREATE POLICY tasks_delete ON tasks FOR DELETE
  USING (is_account_member(account_id, 'admin'));
