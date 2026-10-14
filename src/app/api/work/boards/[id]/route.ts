// Single work board: read (member) with columns + cards,
// update (agent+), delete (admin+; cascades to columns/cards).

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const BOARD_COLUMNS =
  "id, account_id, name, description, created_at, updated_at";
const COLUMN_COLUMNS = "id, board_id, name, position, is_done, created_at";
const CARD_COLUMNS =
  "id, board_id, column_id, title, description, assignee_user_id, due_date, position, lead_id, invoice_id, created_at, updated_at";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data: board, error } = await supabase
      .from("work_boards")
      .select(BOARD_COLUMNS)
      .eq("id", id)
      .single();
    if (error || !board) {
      return NextResponse.json({ error: "Board not found" }, { status: 404 });
    }
    const { data: columns } = await supabase
      .from("board_columns")
      .select(COLUMN_COLUMNS)
      .eq("board_id", id)
      .order("position", { ascending: true });
    const { data: cards } = await supabase
      .from("work_cards")
      .select(CARD_COLUMNS)
      .eq("board_id", id)
      .order("position", { ascending: true });
    return NextResponse.json({
      board,
      columns: columns ?? [],
      cards: cards ?? [],
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    patch.name = name;
  }
  if (body.description !== undefined) {
    patch.description =
      typeof body.description === "string" ? body.description.trim() || null : null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("work_boards")
    .update(patch)
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .select(BOARD_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Board not found" }, { status: 404 });
  }
  return NextResponse.json({ board: data });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  const admin = supabaseAdmin();
  const { error } = await admin
    .from("work_boards")
    .delete()
    .eq("id", id)
    .eq("account_id", ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
