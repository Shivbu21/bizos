// Single column: update (agent+ — rename, reorder, toggle
// is_done), delete (admin+).
//
// Deleting a non-empty column is refused unless the caller passes
// `move_cards_to` with another column id on the same board —
// cards are never silently dropped.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const COLUMN_COLUMNS = "id, board_id, name, position, is_done, created_at";

interface Ctx {
  id: string;
  columnId: string;
}

async function loadColumn(
  admin: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  boardId: string,
  columnId: string,
) {
  const { data } = await admin
    .from("board_columns")
    .select(COLUMN_COLUMNS)
    .eq("id", columnId)
    .eq("board_id", boardId)
    .eq("account_id", accountId)
    .single();
  return data;
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<Ctx> },
) {
  const { id, columnId } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const admin = supabaseAdmin();
  const column = await loadColumn(admin, ctx.accountId, id, columnId);
  if (!column) return NextResponse.json({ error: "Column not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    patch.name = name;
  }
  if (body.position !== undefined) {
    if (!Number.isInteger(body.position) || body.position < 0) {
      return NextResponse.json({ error: "position must be a non-negative integer" }, { status: 400 });
    }
    patch.position = body.position;
  }
  if (body.is_done !== undefined) patch.is_done = !!body.is_done;
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data, error } = await admin
    .from("board_columns")
    .update(patch)
    .eq("id", columnId)
    .select(COLUMN_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Update failed" }, { status: 500 });
  }
  return NextResponse.json({ column: data });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<Ctx> },
) {
  const { id, columnId } = await params;
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => ({}));
  const moveCardsTo =
    typeof body?.move_cards_to === "string" ? body.move_cards_to : null;

  const admin = supabaseAdmin();
  const column = await loadColumn(admin, ctx.accountId, id, columnId);
  if (!column) return NextResponse.json({ error: "Column not found" }, { status: 404 });

  const { data: cards, error: cardsError } = await admin
    .from("work_cards")
    .select("id")
    .eq("column_id", columnId);
  if (cardsError) return NextResponse.json({ error: cardsError.message }, { status: 500 });

  if ((cards?.length ?? 0) > 0) {
    if (!moveCardsTo) {
      return NextResponse.json(
        {
          error: `Column has ${cards?.length} card(s). Pass move_cards_to with another column id, or move the cards first.`,
        },
        { status: 400 },
      );
    }
    const target = await loadColumn(admin, ctx.accountId, id, moveCardsTo);
    if (!target) {
      return NextResponse.json({ error: "move_cards_to column not found" }, { status: 400 });
    }
    const { error: moveError } = await admin
      .from("work_cards")
      .update({ column_id: moveCardsTo })
      .eq("column_id", columnId);
    if (moveError) return NextResponse.json({ error: moveError.message }, { status: 500 });
  }

  const { error } = await admin.from("board_columns").delete().eq("id", columnId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}

// Keep the unused-import guard honest for members reading the
// route without a JSON body on DELETE: read-only callers still
// get a 404/401 path, not a crash.
export async function GET(
  _request: Request,
  { params }: { params: Promise<Ctx> },
) {
  const { id, columnId } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("board_columns")
      .select(COLUMN_COLUMNS)
      .eq("id", columnId)
      .eq("board_id", id)
      .single();
    if (error || !data) {
      return NextResponse.json({ error: "Column not found" }, { status: 404 });
    }
    return NextResponse.json({ column: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
