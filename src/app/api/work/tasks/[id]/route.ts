// Single task: read (member), update (agent+), delete (admin+).
// PATCH { done: true } stamps done_at; { done: false } clears it.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const TASK_COLUMNS =
  "id, account_id, title, description, assignee_user_id, due_at, done, done_at, reminder_at, created_at, updated_at";

function validIso(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const t = new Date(v).getTime();
  return !Number.isNaN(t);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("tasks")
      .select(TASK_COLUMNS)
      .eq("id", id)
      .single();
    if (error || !data) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    return NextResponse.json({ task: data });
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
  if (body.due_at !== undefined) {
    if (body.due_at !== null && !validIso(body.due_at)) {
      return NextResponse.json({ error: "due_at must be an ISO datetime" }, { status: 400 });
    }
    patch.due_at = body.due_at;
  }
  if (body.reminder_at !== undefined) {
    if (body.reminder_at !== null && !validIso(body.reminder_at)) {
      return NextResponse.json({ error: "reminder_at must be an ISO datetime" }, { status: 400 });
    }
    patch.reminder_at = body.reminder_at;
  }
  if (body.done !== undefined) {
    patch.done = !!body.done;
    patch.done_at = body.done ? new Date().toISOString() : null;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("tasks")
    .update(patch)
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .select(TASK_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Task not found" }, { status: 404 });
  }
  return NextResponse.json({ task: data });
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
    .from("tasks")
    .delete()
    .eq("id", id)
    .eq("account_id", ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
