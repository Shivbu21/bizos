// Lead-score backfill — recompute every lead's score (agent+).
//
// POST /api/growth/scores/backfill → { total, ok, failed }

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { backfillLeadScores } from "@/lib/growth/score-store";

export const maxDuration = 120;

export async function POST() {
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }
  try {
    const result = await backfillLeadScores(supabaseAdmin(), ctx.accountId);
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
