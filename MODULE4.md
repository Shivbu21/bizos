# MODULE 4 — Work execution (kanban + attendance + tasks)

The final "work in progress" stage of the rebuild: boards where
delivery work moves, attendance the team actually marks, and
small tasks that don't deserve a card. Built as clean-room code
on the bizos fork — features and workflows only, no third-party
code, copy, or branding. Additive: Modules 1–3 and all base
functionality are untouched (sidebar gained two entries, messages
gained two EN/KO labels).

## What was built

**A. Data model** — `supabase/migrations/042_work_execution.sql`

- `work_boards` — named boards per account.
- `board_columns` — per board, integer `position`, `is_done`
  flag. Board creation seeds "To do" / "In progress" / "Done"
  (Done is `is_done`); all customizable afterwards.
- `work_cards` — fractional `position` (numeric) so drag-drop
  reorders without renumbering siblings; optional `lead_id`
  (Module 1) and `invoice_id` (Module 2) back-links; assignee,
  due date.
- `card_comments` — append-only log. No UPDATE/DELETE policy.
- `attendance_records` — one row per (account, user, day),
  enforced by a unique index; status
  `present / absent / half_day / leave`; check-in/out instants;
  a CHECK constraint keeps check-out ≥ check-in.
- `tasks` — title, assignee, due_at, done/done_at, nullable
  `reminder_at`.
- RLS mirrors Modules 1–3: members read; agent+ manage
  boards/columns/cards/tasks; admin+ delete. Attendance is
  special: members may write their OWN row (self check-in);
  only admin+ may mark or correct another member's row.

**B. Kanban logic** — `src/lib/work/kanban.ts` (pure, 18 unit tests)

- `positionBetween(before, after)` — fractional midpoint math;
  new cards land at max + 1024, gaps start large so splits
  almost never collide.
- `positionForIndex` — drop target slot → new position, with
  index clamping.
- `needsRebalance` / `rebalancePositions` — tight-gap detection
  and clean-integer rewrite of a column, preserving order.
- `validateColumnMove` — target column must exist on the same
  board (cross-board drops are rejected, not silently moved).
- `deriveOverdue` — due_date < today AND not in a Done column.
- `todayYmd` — timezone-aware "today" (Asia/Kolkata default).

**C. Attendance + task helpers** — `src/lib/work/attendance.ts`
(pure, 19 unit tests)

- `buildAttendanceUpsert` — check_in (first stamp of the day
  wins, forces "present"), check_out (requires an existing
  check-in; refuses check-out-before-check-in), set_status
  (validates the four statuses). Throws user-facing errors.
- `canSelfManageAttendance`, `taskReminderDue` (reminder_at past
  and still open), `parseMonthParam` / `parseDateParam`.

**D. API** — `src/app/api/work/…` (13 routes, patterns copied
from Module 3: `getCurrentAccount` reads, `requireRole`
writes, `supabaseAdmin` writes, `params: Promise<…>`)

- `boards`: GET/POST (board create seeds the 3 default
  columns; rolls back the board if column seeding fails).
- `boards/[id]`: GET (board + columns + cards in one call),
  PATCH (agent+), DELETE (admin+).
- `boards/[id]/columns`: GET/POST (agent+; appends right).
- `…/columns/[columnId]`: GET/PATCH (agent+), DELETE (admin+;
  refuses non-empty columns unless `move_cards_to` is given —
  cards are never silently dropped).
- `…/cards`: GET/POST (agent+; validates column belongs to
  the board).
- `…/cards/[cardId]`: GET (card + comments + linked lead /
  invoice summaries), PATCH (agent+), DELETE (admin+).
- `…/cards/[cardId]/move`: POST (agent+) `{column_id?,
  to_index?}` — validates, computes the fractional position,
  rebalances the destination column in the same request when
  gaps run out.
- `…/cards/[cardId]/comments`: GET/POST (agent+; append-only).
- `attendance`: GET `?month=YYYY-MM&user_id=` (member);
  POST `{user_id?, date?, action, status?, notes?}` —
  self-service for anyone, admin-only for others; upserts on
  the unique (account, user, day) key.
- `attendance/today`: GET the caller's row for today.
- `tasks`: GET (filters `?assignee=&open=&due_before=
  &reminder_due=`), POST (agent+).
- `tasks/[id]`: GET/PATCH/DELETE (PATCH `{done}` stamps or
  clears `done_at`).
- `tasks/[id]/complete`: POST (agent+; idempotent — keeps the
  original `done_at`).

**E. Admin UI** — `/work` and `/attendance` (sidebar: Work,
Attendance; EN + KO labels in messages/)

- `/work`: board switcher, horizontal kanban with HTML5
  drag-and-drop (drop on a column appends, drop on a card
  inserts before it), overdue badges + red highlighting,
  assignee/due/link chips per card; card dialog with assignee
  picker, due date, linked-lead and linked-invoice pickers
  (Modules 1–2 data), append-only comments; add/rename/delete
  columns and delete cards are admin-gated
  (`useCan("edit-settings")`), card work is agent+; a Tasks
  strip below with quick-add, one-tap complete, and a
  reminders-due badge.
- `/attendance`: self check-in/check-out card on top; monthly
  team calendar grid (rows = members, columns = days,
  P/A/½/L color cells); clicking a cell opens a detail dialog
  where admins can correct status + note (members see a
  read-only note otherwise).
- Light-first styling identical to Modules 1–3 (`#FAF6EF`
  paper, white cards, indigo `#4F46E5` accent).

## Behavior rules (summary)

1. A card's position is fractional; dropping between two cards
   takes the midpoint; exhausted gaps trigger a same-request
   rebalance of that column only.
2. Overdue = due date before today AND card not in a Done
   column. Cards without due dates are never overdue.
3. Attendance has exactly one row per member per day (unique
   index); the first check-in stamp of the day wins.
4. Comments are append-only everywhere; there is no edit or
   delete path.
5. Deleting a column with cards is refused unless the caller
   names a destination column — cards are never orphaned.

## Deliberately out of scope

- Realtime multi-user drag-drop (no Supabase Realtime
  subscriptions): concurrent moves are last-write-wins on
  position, and the fractional scheme makes collisions rare
  but not impossible.
- Recurring tasks, task subtasks, card checklists.
- Geofenced / photo check-in — stamps are trust-based.
- Board templates and card print/PDF export.

## Verified

- `tsc --noEmit` clean (5 errors found and fixed during the
  build: Base-UI `Select onValueChange` passes `string | null`
  ×4, and `DropdownMenuTrigger` here takes children, not
  `asChild`).
- `npm run build` succeeds (dummy Supabase env, same caveat as
  Modules 2–3). `/work`, `/attendance`, and all 13
  `/api/work/*` routes present in the production output.
- `npm test` (vitest): **932 passed / 86 files** (up from 895),
  including **37 new tests** — fractional positioning
  (append/prepend/midpoint/clamps), rebalance detection,
  cross-board move rejection, overdue derivation (today is not
  overdue; Done-column cards excluded), attendance upsert
  payloads (double check-in keeps first stamp, check-out
  guards), reminder derivation, month/date parsing.
- The test suite caught a real bug: `positionBetween` had its
  prepend/append arms inverted (symmetric midpoint tests
  passed, edge tests failed). Fixed and green.

## Not verified (needs real services / data)

- The Supabase migration was syntax-checked, not applied to a
  live database (no Supabase project exists for this fork yet)
  — tables, the unique attendance index, and RLS policies need
  a live apply to be proven end-to-end.
- Drag-and-drop was not exercised in a real browser (headless
  build only); the HTML5 DnD handlers are written but
  unclicked.
- No concurrent-move or concurrent check-in race was tested;
  the unique index and fractional positions are the safety
  nets, by construction.
- Linked-lead/invoice pickers assume the Module 1/2 list
  endpoints' shapes; not exercised against live data.
