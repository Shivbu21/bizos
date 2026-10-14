// Lead-score leaderboard — member read with sort/filter.
//
// GET /api/growth/scores?sort=score_desc|score_asc&min_score=&status=&limit=
//   → { scores: [{ lead_id, score, breakdown, computed_at, lead: { name, phone, status, source } }] }

import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";

const STATUSES = ["new", "contacted", "qualified", "converted", "lost"] as const;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const sort = searchParams.get("sort") === "score_asc" ? "score_asc" : "score_desc";
  const minScore = Math.max(0, Math.min(100, Number(searchParams.get("min_score") ?? 0) || 0));
  const status = searchParams.get("status");
  const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") ?? 50) || 50));

  if (status && !(STATUSES as readonly string[]).includes(status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  try {
    const { supabase } = await getCurrentAccount();
    let q = supabase
      .from("lead_scores")
      .select(
        "lead_id, score, breakdown, computed_at, leads!inner(id, name, phone, status, source)",
      )
      .gte("score", minScore)
      .order("score", { ascending: sort === "score_asc" })
      .limit(limit);
    if (status) q = q.eq("leads.status", status);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ scores: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
