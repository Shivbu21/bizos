// Referral codes — get-or-create per contact (agent+), list (member).
//
// POST /api/growth/referrals/code   { contact_id } → { code }
// GET  /api/growth/referrals/code?contact_id=… → { code } | 404

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { generateReferralCode } from "@/lib/growth/referrals";

function isUniqueViolation(err: { code?: string }): boolean {
  return err?.code === "23505";
}

async function getOrCreateCode(
  admin: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  contactId: string,
): Promise<string> {
  const { data: existing } = await admin
    .from("referral_codes")
    .select("code")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .maybeSingle();
  if (existing?.code) return existing.code as string;

  // Retry on the (astronomically unlikely) code collision.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateReferralCode();
    const { data, error } = await admin
      .from("referral_codes")
      .insert({ account_id: accountId, contact_id: contactId, code })
      .select("code")
      .single();
    if (!error && data) return data.code as string;
    if (error && !isUniqueViolation(error as { code?: string })) {
      throw new Error(`referral code insert failed: ${(error as Error).message}`);
    }
    // Collision (or lost race with another creator) — check whether
    // the row now exists before generating a fresh code.
    const { data: raced } = await admin
      .from("referral_codes")
      .select("code")
      .eq("account_id", accountId)
      .eq("contact_id", contactId)
      .maybeSingle();
    if (raced?.code) return raced.code as string;
  }
  throw new Error("could not mint a unique referral code");
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const contactId = searchParams.get("contact_id");
  if (!contactId) {
    return NextResponse.json({ error: "contact_id is required" }, { status: 400 });
  }
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("referral_codes")
      .select("code, created_at")
      .eq("contact_id", contactId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "no code yet" }, { status: 404 });
    return NextResponse.json({ code: data.code, created_at: data.created_at });
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
  const contactId = typeof body?.contact_id === "string" ? body.contact_id : "";
  if (!contactId) {
    return NextResponse.json({ error: "contact_id is required" }, { status: 400 });
  }
  try {
    // Tenancy check: the contact must belong to this account.
    const admin = supabaseAdmin();
    const { data: contact } = await admin
      .from("contacts")
      .select("id")
      .eq("id", contactId)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!contact) {
      return NextResponse.json({ error: "contact not found" }, { status: 404 });
    }
    const code = await getOrCreateCode(admin, ctx.accountId, contactId);
    return NextResponse.json({ code }, { status: 200 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
