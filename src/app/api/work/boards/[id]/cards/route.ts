// Board cards — list (member) and create (agent+).
// New cards land at the end of their column.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { POSITION_GAP } from "@/lib/work/kanban";

const CARD_COLUMNS =
  "id, board_id, column_id, title, description, assignee_user_id, due_date, position, lead_id, invoice_id, created_at, updated_at";

function validDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("work_cards")
      .select(CARD_COLUMNS)
      .eq("board_id", id)
      .order("position", { ascending: true })
      .limit(1000);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ cards: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
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

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  if (body.column_id === undefined || typeof body.column_id !== "string") {
    return NextResponse.json({ error: "column_id is required" }, { status: 400 });
  }
  if (body.due_date !== undefined && body.due_date !== null && !validDate(body.due_date)) {
    return NextResponse.json({ error: "due_date must be YYYY-MM-DD" }, { status: 400 });
  }

  const admin = supabaseAdmin();

  // Column must belong to this board and this account.
  const { data: column } = await admin
    .from("board_columns")
    .select("id")
    .eq("id", body.column_id)
    .eq("board_id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (!column) {
    return NextResponse.json({ error: "Column not found on this board" }, { status: 400 });
  }

  const { data: maxRow } = await admin
    .from("work_cards")
    .select("position")
    .eq("column_id", body.column_id)
    .order("position", { ascending: false })
    .limit(1)
    .single();

  const insert: Record<string, unknown> = {
    account_id: ctx.accountId,
    board_id: id,
    column_id: body.column_id,
    title,
    description:
      typeof body.description === "string" ? body.description.trim() || null : null,
    assignee_user_id:
      typeof body.assignee_user_id === "string" && body.assignee_user_id
        ? body.assignee_user_id
        : null,
    due_date: body.due_date ?? null,
    position: maxRow ? Number(maxRow.position) + POSITION_GAP : POSITION_GAP,
    lead_id: typeof body.lead_id === "string" && body.lead_id ? body.lead_id : null,
    invoice_id:
      typeof body.invoice_id === "string" && body.invoice_id ? body.invoice_id : null,
    created_by: ctx.userId,
  };

  const { data, error } = await admin
    .from("work_cards")
    .insert(insert)
    .select(CARD_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to create card" },
      { status: 500 },
    );
  }
  return NextResponse.json({ card: data }, { status: 201 });
}
