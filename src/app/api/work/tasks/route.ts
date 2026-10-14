// Tasks — list (member; filters: ?assignee=, ?open=true,
// ?due_before=YYYY-MM-DD, ?reminder_due=true) and create (agent+).

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { taskReminderDue } from "@/lib/work/attendance";

const TASK_COLUMNS =
  "id, account_id, title, description, assignee_user_id, due_at, done, done_at, reminder_at, created_at, updated_at";

function validIso(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const t = new Date(v).getTime();
  return !Number.isNaN(t);
}

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount();
    const url = new URL(request.url);
    const assignee = url.searchParams.get("assignee");
    const openOnly = url.searchParams.get("open") === "true";
    const dueBefore = url.searchParams.get("due_before");
    const reminderDue = url.searchParams.get("reminder_due") === "true";

    let query = supabase
      .from("tasks")
      .select(TASK_COLUMNS)
      .order("due_at", { ascending: true, nullsFirst: false })
      .limit(500);
    if (assignee) query = query.eq("assignee_user_id", assignee);
    if (openOnly) query = query.eq("done", false);
    if (dueBefore && validIso(dueBefore)) query = query.lte("due_at", dueBefore);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let tasks = data ?? [];
    if (reminderDue) {
      const nowIso = new Date().toISOString();
      tasks = tasks.filter((t) => taskReminderDue(t, nowIso));
    }
    return NextResponse.json({ tasks });
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

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "title is required" }, { status: 400 });
  if (body.due_at !== undefined && body.due_at !== null && !validIso(body.due_at)) {
    return NextResponse.json({ error: "due_at must be an ISO datetime" }, { status: 400 });
  }
  if (
    body.reminder_at !== undefined &&
    body.reminder_at !== null &&
    !validIso(body.reminder_at)
  ) {
    return NextResponse.json({ error: "reminder_at must be an ISO datetime" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("tasks")
    .insert({
      account_id: ctx.accountId,
      title,
      description:
        typeof body.description === "string" ? body.description.trim() || null : null,
      assignee_user_id:
        typeof body.assignee_user_id === "string" && body.assignee_user_id
          ? body.assignee_user_id
          : null,
      due_at: body.due_at ?? null,
      reminder_at: body.reminder_at ?? null,
      created_by: ctx.userId,
    })
    .select(TASK_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to create task" },
      { status: 500 },
    );
  }
  return NextResponse.json({ task: data }, { status: 201 });
}
