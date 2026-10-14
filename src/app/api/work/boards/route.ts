// Work boards — list (member) and create (agent+).
//
// Creating a board also seeds the three default columns
// ("To do" / "In progress" / "Done"); columns stay fully
// customizable afterwards.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const BOARD_COLUMNS =
  "id, account_id, name, description, created_at, updated_at";

const DEFAULT_COLUMNS = [
  { name: "To do", position: 0, is_done: false },
  { name: "In progress", position: 1, is_done: false },
  { name: "Done", position: 2, is_done: true },
];

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("work_boards")
      .select(BOARD_COLUMNS)
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ boards: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
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
  const { data: board, error: boardError } = await admin
    .from("work_boards")
    .insert({
      account_id: ctx.accountId,
      name,
      description:
        typeof body.description === "string" ? body.description.trim() || null : null,
      created_by: ctx.userId,
    })
    .select(BOARD_COLUMNS)
    .single();
  if (boardError || !board) {
    return NextResponse.json(
      { error: boardError?.message ?? "Failed to create board" },
      { status: 500 },
    );
  }

  const { error: colError } = await admin.from("board_columns").insert(
    DEFAULT_COLUMNS.map((c) => ({
      account_id: ctx.accountId,
      board_id: board.id,
      ...c,
    })),
  );
  if (colError) {
    // Roll back the half-created board rather than leaving a
    // board with no columns behind.
    await admin.from("work_boards").delete().eq("id", board.id);
    return NextResponse.json({ error: colError.message }, { status: 500 });
  }

  return NextResponse.json({ board }, { status: 201 });
}
