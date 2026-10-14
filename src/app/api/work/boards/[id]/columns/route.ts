// Board columns — list (member) and create (agent+).
// New columns append to the right (position = max + 1).

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const COLUMN_COLUMNS = "id, board_id, name, position, is_done, created_at";

async function boardExists(
  admin: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  boardId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("work_boards")
    .select("id")
    .eq("id", boardId)
    .eq("account_id", accountId)
    .single();
  return !!data;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("board_columns")
      .select(COLUMN_COLUMNS)
      .eq("board_id", id)
      .order("position", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ columns: data ?? [] });
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

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const admin = supabaseAdmin();
  if (!(await boardExists(admin, ctx.accountId, id))) {
    return NextResponse.json({ error: "Board not found" }, { status: 404 });
  }

  const { data: maxRow } = await admin
    .from("board_columns")
    .select("position")
    .eq("board_id", id)
    .order("position", { ascending: false })
    .limit(1)
    .single();

  const { data, error } = await admin
    .from("board_columns")
    .insert({
      account_id: ctx.accountId,
      board_id: id,
      name,
      position: (maxRow?.position ?? -1) + 1,
      is_done: body.is_done === true,
    })
    .select(COLUMN_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to create column" },
      { status: 500 },
    );
  }
  return NextResponse.json({ column: data }, { status: 201 });
}
