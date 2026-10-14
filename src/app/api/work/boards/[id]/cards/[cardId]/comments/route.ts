// Card comments — list (member) and add (agent+).
// Append-only: there is no update or delete path.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const COMMENT_COLUMNS = "id, card_id, author_user_id, body, created_at";

interface Ctx {
  id: string;
  cardId: string;
}

export async function GET(_request: Request, { params }: { params: Promise<Ctx> }) {
  const { id, cardId } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    // Tenancy check: the card must belong to this board.
    const { data: card } = await supabase
      .from("work_cards")
      .select("id")
      .eq("id", cardId)
      .eq("board_id", id)
      .single();
    if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });

    const { data, error } = await supabase
      .from("card_comments")
      .select(COMMENT_COLUMNS)
      .eq("card_id", cardId)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ comments: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

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

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) return NextResponse.json({ error: "body is required" }, { status: 400 });
  if (text.length > 4000) {
    return NextResponse.json({ error: "body is too long (max 4000 characters)" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data: card } = await admin
    .from("work_cards")
    .select("id, account_id")
    .eq("id", cardId)
    .eq("board_id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (!card) return NextResponse.json({ error: "Card not found" }, { status: 404 });

  const { data, error } = await admin
    .from("card_comments")
    .insert({
      account_id: ctx.accountId,
      card_id: cardId,
      author_user_id: ctx.userId,
      body: text,
    })
    .select(COMMENT_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to add comment" },
      { status: 500 },
    );
  }
  return NextResponse.json({ comment: data }, { status: 201 });
}
