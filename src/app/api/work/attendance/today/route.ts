// Today's attendance for the caller — one-tap check-in/out
// surface. Any signed-in member may read their own row.

import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { todayYmd } from "@/lib/work/kanban";

const ROW_COLUMNS =
  "id, account_id, user_id, date, status, check_in_at, check_out_at, notes, created_at, updated_at";

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const today = todayYmd();
    const { data, error } = await ctx.supabase
      .from("attendance_records")
      .select(ROW_COLUMNS)
      .eq("user_id", ctx.userId)
      .eq("date", today)
      .single();
    if (error && error.code !== "PGRST116") {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ record: data ?? null, date: today });
  } catch (err) {
    return toErrorResponse(err);
  }
}
