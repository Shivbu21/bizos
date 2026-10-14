// Single card: read (member) with comments + linked lead/invoice
// summaries, update (agent+), delete (admin+).

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const CARD_COLUMNS =
  "id, account_id, board_id, column_id, title, description, assignee_user_id, due_date, position, lead_id, invoice_id, created_at, updated_at";
const COMMENT_COLUMNS = "id, card_id, author_user_id, body, created_at";

interface Ctx {
  id: string;
  cardId: string;
}

function validDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

export async function GET(_request: Request, { params }: { params: Promise<Ctx> }) {
  const { id, cardId } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data: card, error } = await supabase
      .from("work_cards")
      .select(CARD_COLUMNS)
      .eq("id", cardId)
      .eq("board_id", id)
      .single();
    if (error || !card) {
      return NextResponse.json({ error: "Card not found" }, { status: 404 });
    }
    const { data: comments } = await supabase
      .from("card_comments")
      .select(COMMENT_COLUMNS)
      .eq("card_id", cardId)
      .order("created_at", { ascending: true });

    // Linked Module 1 lead / Module 2 invoice summaries for the
    // card dialog. Null-safe: links are optional.
    let lead: unknown = null;
    let invoice: unknown = null;
    if (card.lead_id) {
      const { data } = await supabase
        .from("leads")
        .select("id, name, phone, status")
        .eq("id", card.lead_id)
        .single();
      lead = data ?? null;
    }
    if (card.invoice_id) {
      const { data } = await supabase
        .from("invoices")
        .select("id, number, buyer_name, status, total_paise")
        .eq("id", card.invoice_id)
        .single();
      invoice = data ?? null;
    }
    return NextResponse.json({ card, comments: comments ?? [], lead, invoice });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
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

  const patch: Record<string, unknown> = {};
  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
    patch.title = title;
  }
  if (body.description !== undefined) {
    patch.description =
      typeof body.description === "string" ? body.description.trim() || null : null;
  }
  if (body.assignee_user_id !== undefined) {
    patch.assignee_user_id =
      typeof body.assignee_user_id === "string" && body.assignee_user_id
        ? body.assignee_user_id
        : null;
  }
  if (body.due_date !== undefined) {
    if (body.due_date !== null && !validDate(body.due_date)) {
      return NextResponse.json({ error: "due_date must be YYYY-MM-DD" }, { status: 400 });
    }
    patch.due_date = body.due_date;
  }
  if (body.lead_id !== undefined) {
    patch.lead_id = typeof body.lead_id === "string" && body.lead_id ? body.lead_id : null;
  }
  if (body.invoice_id !== undefined) {
    patch.invoice_id =
      typeof body.invoice_id === "string" && body.invoice_id ? body.invoice_id : null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("work_cards")
    .update(patch)
    .eq("id", cardId)
    .eq("board_id", id)
    .eq("account_id", ctx.accountId)
    .select(CARD_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Card not found" }, { status: 404 });
  }
  return NextResponse.json({ card: data });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<Ctx> },
) {
  const { id, cardId } = await params;
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  const admin = supabaseAdmin();
  const { error } = await admin
    .from("work_cards")
    .delete()
    .eq("id", cardId)
    .eq("board_id", id)
    .eq("account_id", ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
