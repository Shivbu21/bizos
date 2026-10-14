// Card move — the drag-and-drop endpoint (agent+).
//
// POST { column_id?, to_index? }
//   - column_id omitted or equal to the current column: reorder
//     within the same column.
//   - column_id different: move across columns (validated to stay
//     on the same board).
//   - to_index: 0-based target slot in the destination column,
//     counting only the column's other cards. Omitted → append.
//
// Positions are fractional; when the target column's gaps get too
// tight the whole column is rebalanced to clean integer slots in
// the same request.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  needsRebalance,
  positionForIndex,
  rebalancePositions,
  validateColumnMove,
} from "@/lib/work/kanban";

interface Ctx {
  id: string;
  cardId: string;
}

const CARD_COLUMNS =
  "id, account_id, board_id, column_id, position";

export async function POST(
  request: Request,
  { params }: { params: Promise<Ctx> },
) {
  const { id, cardId } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const toIndex =
    body.to_index === undefined ? null : Number(body.to_index);
  if (toIndex !== null && (!Number.isInteger(toIndex) || toIndex < 0)) {
    return NextResponse.json(
      { error: "to_index must be a non-negative integer" },
      { status: 400 },
    );
  }
  const targetColumnId =
    typeof body.column_id === "string" && body.column_id ? body.column_id : null;

  const admin = supabaseAdmin();

  const { data: card, error: cardError } = await admin
    .from("work_cards")
    .select(CARD_COLUMNS)
    .eq("id", cardId)
    .eq("board_id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (cardError || !card) {
    return NextResponse.json({ error: "Card not found" }, { status: 404 });
  }

  const destColumnId = targetColumnId ?? card.column_id;
  const { data: columns } = await admin
    .from("board_columns")
    .select("id, board_id")
    .eq("board_id", id);
  const moveError = validateColumnMove(
    card.board_id,
    destColumnId,
    (columns ?? []).map((c) => ({ id: c.id, board_id: c.board_id })),
  );
  if (moveError) return NextResponse.json({ error: moveError }, { status: 400 });

  // Sibling cards in the destination column, excluding the moved
  // card. Supabase returns numeric as string — parse before the
  // pure ordering math.
  const { data: siblings } = await admin
    .from("work_cards")
    .select("id, position")
    .eq("column_id", destColumnId)
    .neq("id", cardId)
    .order("position", { ascending: true });
  const rest = (siblings ?? []).map((s) => ({
    id: s.id,
    position: Number(s.position),
  }));

  const position = positionForIndex(rest, toIndex ?? rest.length);

  // Rebalance the destination column when gaps are exhausted.
  const allPositions = [...rest.map((r) => r.position), position];
  let rebalanced = false;
  if (needsRebalance(allPositions)) {
    const ordered = [...rest, { id: cardId, position }].sort(
      (a, b) => a.position - b.position,
    );
    const map = rebalancePositions(ordered);
    for (const [cid, pos] of map) {
      const { error } = await admin
        .from("work_cards")
        .update({ position: pos })
        .eq("id", cid);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    rebalanced = true;
  } else {
    const { error } = await admin
      .from("work_cards")
      .update({ column_id: destColumnId, position })
      .eq("id", cardId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    moved: true,
    card_id: cardId,
    column_id: destColumnId,
    position,
    rebalanced,
  });
}
