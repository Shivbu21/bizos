// Mark a task complete (agent+). Idempotent — completing an
// already-done task keeps the original done_at stamp.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const TASK_COLUMNS =
  "id, account_id, title, description, assignee_user_id, due_at, done, done_at, reminder_at, created_at, updated_at";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const admin = supabaseAdmin();
  const { data: existing, error: loadError } = await admin
    .from("tasks")
    .select("id, done, done_at")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (loadError || !existing) {
    return NextResponse.json({ error: "Task not found" }, { status: 404 });
  }
  if (existing.done) {
    const { data } = await admin
      .from("tasks")
      .select(TASK_COLUMNS)
      .eq("id", id)
      .single();
    return NextResponse.json({ task: data, already_done: true });
  }

  const { data, error } = await admin
    .from("tasks")
    .update({ done: true, done_at: new Date().toISOString() })
    .eq("id", id)
    .select(TASK_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Update failed" }, { status: 500 });
  }
  return NextResponse.json({ task: data, already_done: false });
}
