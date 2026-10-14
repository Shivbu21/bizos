// Review-request queue — member read.
//
// GET /api/growth/reviews?status=pending|sent|failed&limit=
//   → { reviews: [{ id, due_at, status, sent_at, contact: { name }, invoice: { number } }] }

import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const STATUSES = ["pending", "sent", "failed"] as const;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get("status");
  const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") ?? 50) || 50));
  if (status && !(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  try {
    const { supabase } = await getCurrentAccount();
    let q = supabase
      .from("review_requests")
      .select(
        "id, due_at, status, sent_at, error, contacts!inner(name), invoices!inner(number)",
      )
      .order("due_at", { ascending: false })
      .limit(limit);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ reviews: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
