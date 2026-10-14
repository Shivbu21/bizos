// Follow-up drip scheduler — secret-verified cron entry point.
//
// POST /api/cron/followups
//   Header: x-cron-secret: <FOLLOWUP_CRON_SECRET>
//
// Trigger it every 5–15 minutes from any scheduler:
//   - Vercel Cron: add {"path": "/api/cron/followups", "schedule": "*/10 * * * *"} to vercel.json
//   - pg_cron: SELECT cron.schedule('followups', '*/10 * * * *',
//       $$SELECT net.http_post('https://<host>/api/cron/followups',
//         headers := '{"x-cron-secret": "<secret>"}'::jsonb)$$);
//   - External pinger (cron-job.org, UptimeRobot): POST the URL with the header.
//
// The claim step inside processDueFollowups makes overlapping
// invocations safe — a second tick simply finds nothing due.

import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { processDueFollowups } from "@/lib/followups/send";
import { scanWinback } from "@/lib/growth/winback";
import { processReviewRequests } from "@/lib/growth/reviews";

export const maxDuration = 120;

export async function POST(request: Request) {
  const expected = process.env.FOLLOWUP_CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const supplied = request.headers.get("x-cron-secret") ?? "";
  const suppliedBuf = Buffer.from(supplied);
  const expectedBuf = Buffer.from(expected);
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = supabaseAdmin();
  const followups = await processDueFollowups(admin);
  // Module 5 (growth): win-back enrollment scan + review-request
  // queue. Both are idempotent and safe on every tick; failures
  // are isolated so one never blocks the others.
  let winback = { accountsScanned: 0, enrolled: 0 };
  try {
    winback = await scanWinback(admin);
  } catch (err) {
    console.error("[growth] winback scan failed:", err);
  }
  let reviews = { examined: 0, sent: 0, failed: 0 };
  try {
    reviews = await processReviewRequests(admin);
  } catch (err) {
    console.error("[growth] review processing failed:", err);
  }
  return NextResponse.json({ ok: true, followups, winback, reviews });
}
