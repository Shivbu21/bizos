// Attendance — monthly roster read (member) and mark (self
// check-in by any member; another member's row only by admin+).
//
// POST { user_id?, date?, action: "check_in"|"check_out"|"set_status",
//        status?, notes? }
//   - user_id omitted → the caller. Anyone may write their own
//     row; writing someone else's needs admin.
//   - date omitted → today (Asia/Kolkata). The unique index on
//     (account_id, user_id, date) makes the write idempotent.

import { NextResponse } from "next/server";
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  buildAttendanceUpsert,
  canSelfManageAttendance,
  parseDateParam,
  parseMonthParam,
  type AttendanceAction,
} from "@/lib/work/attendance";
import { todayYmd } from "@/lib/work/kanban";

const ROW_COLUMNS =
  "id, account_id, user_id, date, status, check_in_at, check_out_at, notes, created_at, updated_at";

function monthRange(month: string): { start: string; end: string } {
  const [y, m] = month.split("-").map(Number);
  const start = `${month}-01`;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${month}-${String(lastDay).padStart(2, "0")}` };
}

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount();
    const url = new URL(request.url);
    const monthRaw = url.searchParams.get("month");
    const month = monthRaw
      ? parseMonthParam(monthRaw)
      : todayYmd().slice(0, 7);
    const { start, end } = monthRange(month);
    const userId = url.searchParams.get("user_id");

    let query = supabase
      .from("attendance_records")
      .select(ROW_COLUMNS)
      .gte("date", start)
      .lte("date", end)
      .order("date", { ascending: true })
      .limit(5000);
    if (userId) query = query.eq("user_id", userId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ records: data ?? [], month, start, end });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("month must")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  let ctx;
  try {
    // Members may mark their own attendance; touching another
    // member's row escalates to admin inside the handler.
    ctx = await requireRole("viewer");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const action = body.action as AttendanceAction | undefined;
  if (action !== "check_in" && action !== "check_out" && action !== "set_status") {
    return NextResponse.json(
      { error: 'action must be check_in, check_out, or set_status' },
      { status: 400 },
    );
  }

  const targetUserId =
    typeof body.user_id === "string" && body.user_id ? body.user_id : ctx.userId;
  const needsAdmin = !canSelfManageAttendance(ctx.userId, targetUserId);
  if (needsAdmin && ctx.role !== "owner" && ctx.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can mark attendance for other members" },
      { status: 403 },
    );
  }

  let date: string;
  try {
    date = body.date === undefined ? todayYmd() : parseDateParam(body.date);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Bad date" },
      { status: 400 },
    );
  }

  const nowIso = new Date().toISOString();
  const admin = supabaseAdmin();

  const { data: existing } = await admin
    .from("attendance_records")
    .select("id, check_in_at, check_out_at, status")
    .eq("account_id", ctx.accountId)
    .eq("user_id", targetUserId)
    .eq("date", date)
    .single();

  let payload: Record<string, unknown>;
  try {
    payload = buildAttendanceUpsert(action, existing ?? null, {
      nowIso,
      status: body.status,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid action" },
      { status: 400 },
    );
  }

  // Notes are admin/correction metadata — only attach on explicit
  // set_status so routine check-ins stay clean.
  if (action === "set_status" && typeof body.notes === "string" && body.notes.trim()) {
    payload.notes = body.notes.trim().slice(0, 500);
  }

  const { data, error } = await admin
    .from("attendance_records")
    .upsert(
      {
        account_id: ctx.accountId,
        user_id: targetUserId,
        date,
        ...payload,
        created_by: ctx.userId,
      },
      { onConflict: "account_id,user_id,date" },
    )
    .select(ROW_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Failed to record attendance" },
      { status: 500 },
    );
  }
  return NextResponse.json({ record: data }, { status: existing ? 200 : 201 });
}
