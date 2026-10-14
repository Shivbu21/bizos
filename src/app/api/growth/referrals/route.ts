// Referrals log — record + list (agent+ record, member read).
//
// POST /api/growth/referrals
//   { code, referee_lead_id? | referee_contact_id?, reward_note? }
//   → 201 { referral } · 404 unknown code · 409 self-referral
// GET /api/growth/referrals?contact_id=…  → referrals made BY that contact
// GET /api/growth/referrals  → recent referrals (member, limit 100)

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { normalizeReferralCode } from "@/lib/growth/referrals";

const LIST_COLUMNS =
  "id, code, status, reward_note, created_at, referrer_contact_id, referee_lead_id, referee_contact_id";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const contactId = searchParams.get("contact_id");
  try {
    const { supabase } = await getCurrentAccount();
    let q = supabase
      .from("referrals")
      .select(LIST_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(100);
    if (contactId) q = q.eq("referrer_contact_id", contactId);
    const { data, error } = await q;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ referrals: data ?? [] });
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
  const code = normalizeReferralCode(typeof body?.code === "string" ? body.code : null);
  const refereeLeadId =
    typeof body?.referee_lead_id === "string" ? body.referee_lead_id : null;
  const refereeContactId =
    typeof body?.referee_contact_id === "string" ? body.referee_contact_id : null;
  const rewardNote =
    typeof body?.reward_note === "string" && body.reward_note.trim()
      ? body.reward_note.trim().slice(0, 500)
      : null;

  if (!code) return NextResponse.json({ error: "valid code is required" }, { status: 400 });
  if (!refereeLeadId && !refereeContactId) {
    return NextResponse.json(
      { error: "referee_lead_id or referee_contact_id is required" },
      { status: 400 },
    );
  }

  try {
    const admin = supabaseAdmin();
    const { data: codeRow } = await admin
      .from("referral_codes")
      .select("contact_id")
      .eq("account_id", ctx.accountId)
      .eq("code", code)
      .maybeSingle();
    if (!codeRow) {
      return NextResponse.json({ error: "unknown referral code" }, { status: 404 });
    }
    const referrerId = codeRow.contact_id as string;
    if (refereeContactId === referrerId) {
      return NextResponse.json({ error: "self-referral is not allowed" }, { status: 409 });
    }

    const { data, error } = await admin
      .from("referrals")
      .insert({
        account_id: ctx.accountId,
        referrer_contact_id: referrerId,
        referee_lead_id: refereeLeadId,
        referee_contact_id: refereeContactId,
        code,
        reward_note: rewardNote,
      })
      .select(LIST_COLUMNS)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ referral: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
