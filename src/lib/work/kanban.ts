// Kanban ordering + move validation + overdue derivation — pure
// functions, no DB, no framework. Module 4 (work-execution).
//
// Position model
// --------------
// Cards carry a fractional `position` (numeric in the DB). New
// cards land at max+POSITION_GAP; a card dropped between two cards
// takes the midpoint. Gaps start large so midpoint splits almost
// never collide; when they do (adjacent gap < REBALANCE_EPSILON),
// the caller rebalances the whole column to clean integers —
// `rebalancePositions` computes the replacement map.
//
// All comparisons use plain numbers. The DB stores `numeric`,
// which the Supabase client returns as a string; routes parse
// with Number() before calling into this module.

export const POSITION_GAP = 1024;
export const REBALANCE_EPSILON = 1e-6;

export interface CardLike {
  id: string;
  position: number;
}

export interface ColumnLike {
  id: string;
  board_id: string;
}

/**
 * Position for a card dropped between `before` and `after`
 * (positions of the neighboring cards after the drop, null when
 * there is no neighbor on that side).
 *
 * - (null, null) — empty column → POSITION_GAP
 * - (null, b)    — dropped before the first card → b - GAP
 * - (a, null)    — dropped after the last card → a + GAP
 * - (a, b)       — between two cards → midpoint
 */
export function positionBetween(
  before: number | null,
  after: number | null,
): number {
  if (before === null && after === null) return POSITION_GAP;
  if (before === null) return (after as number) - POSITION_GAP;
  if (after === null) return before + POSITION_GAP;
  return (before + after) / 2;
}

/**
 * Position for a card moved within its column to `toIndex`
 * (0-based) in the column's card order *excluding the moved card*.
 * Returns the new fractional position; the card keeps its identity.
 */
export function positionForIndex(
  cardsExcludingMoved: CardLike[],
  toIndex: number,
): number {
  const sorted = [...cardsExcludingMoved].sort((a, b) => a.position - b.position);
  const clamped = Math.max(0, Math.min(toIndex, sorted.length));
  const before = clamped === 0 ? null : sorted[clamped - 1].position;
  const after = clamped === sorted.length ? null : sorted[clamped].position;
  return positionBetween(before, after);
}

/**
 * True when any adjacent pair in a sorted column is too tight to
 * split again — the signal to run a rebalance instead of writing
 * a midpoint that would collide.
 */
export function needsRebalance(positions: number[]): boolean {
  const sorted = [...positions].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] < REBALANCE_EPSILON) return true;
  }
  return false;
}

/**
 * Rebalance map: card id → clean integer position (GAP, 2*GAP, …)
 * preserving the given order. The caller writes these back.
 */
export function rebalancePositions(cardsInOrder: CardLike[]): Map<string, number> {
  const map = new Map<string, number>();
  cardsInOrder.forEach((card, i) => {
    map.set(card.id, (i + 1) * POSITION_GAP);
  });
  return map;
}

/**
 * Validate a card move into `targetColumnId`. The target column
 * must exist and belong to the card's board. Returns an error
 * string, or null when the move is legal.
 */
export function validateColumnMove(
  cardBoardId: string,
  targetColumnId: string,
  columns: ColumnLike[],
): string | null {
  const target = columns.find((c) => c.id === targetColumnId);
  if (!target) return "Target column does not exist";
  if (target.board_id !== cardBoardId) {
    return "Target column belongs to a different board";
  }
  return null;
}

/**
 * Overdue cards: a due_date strictly before `todayYmd`
 * ("YYYY-MM-DD") AND the card is not sitting in a Done column.
 * Cards without a due date are never overdue.
 */
export function deriveOverdue(
  cards: Array<{ id: string; due_date: string | null; column_id: string }>,
  doneColumnIds: Set<string>,
  todayYmd: string,
): string[] {
  return cards
    .filter(
      (c) =>
        c.due_date !== null &&
        c.due_date < todayYmd &&
        !doneColumnIds.has(c.column_id),
    )
    .map((c) => c.id);
}

/**
 * Today's date as "YYYY-MM-DD" in the given IANA timezone
 * (default Asia/Kolkata, matching the account default elsewhere).
 */
export function todayYmd(timezone = "Asia/Kolkata"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
