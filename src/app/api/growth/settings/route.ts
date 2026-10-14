// Growth settings — read (member) and update (admin).
//
// GET  /api/growth/settings → { settings } (defaults when absent)
// PATCH /api/growth/settings → { settings }
//   { winback_enabled, winback_dormancy_days, winback_sequence_id,
//     winback_exclude_recent_days, review_enabled, review_delay_days,
//     review_template }

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const COLUMNS =
  "account_id, winback_enabled, winback_dormancy_days, winback_sequence_id, winback_exclude_recent_days, review_enabled, review_delay_days, review_template, updated_at";

const DEFAULTS = {
  winback_enabled: false,
  winback_dormancy_days: 60,
  winback_sequence_id: null as string | null,
  winback_exclude_recent_days: 90,
  review_enabled: false,
  review_delay_days: 2,
  review_template:
    "Hi {{name}}, thanks for your business! If you had a great experience, a quick review would mean a lot to us.",
};

export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("growth_settings")
      .select(COLUMNS)
      .eq("account_id", accountId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ settings: { ...DEFAULTS, ...(data ?? {}) } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const setBool = (key: string, field: string) => {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "boolean")
        throw new Error(`${key} must be a boolean`);
      patch[field] = body[key];
    }
  };
  const setInt = (key: string, field: string, min: number, max: number) => {
    if (body[key] !== undefined) {
      const n = Number(body[key]);
      if (!Number.isInteger(n) || n < min || n > max)
        throw new Error(`${key} must be an integer ${min}–${max}`);
      patch[field] = n;
    }
  };
  try {
    setBool("winback_enabled", "winback_enabled");
    setInt("winback_dormancy_days", "winback_dormancy_days", 7, 365);
    setInt("winback_exclude_recent_days", "winback_exclude_recent_days", 0, 365);
    setBool("review_enabled", "review_enabled");
    setInt("review_delay_days", "review_delay_days", 0, 30);
    if (body.winback_sequence_id !== undefined) {
      const v = body.winback_sequence_id;
      if (v !== null && typeof v !== "string")
        throw new Error("winback_sequence_id must be a UUID or null");
      patch.winback_sequence_id = v;
    }
    if (body.review_template !== undefined) {
      const v = body.review_template;
      if (typeof v !== "string" || !v.trim() || v.length > 2000)
        throw new Error("review_template must be 1–2000 characters");
      patch.review_template = v.trim();
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid input" },
      { status: 400 },
    );
  }

  // Win-back sequence must belong to this account and be kind='winback'.
  if (patch.winback_sequence_id) {
    const admin = supabaseAdmin();
    const { data: seq } = await admin
      .from("followup_sequences")
      .select("id, kind")
      .eq("id", patch.winback_sequence_id as string)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!seq) {
      return NextResponse.json({ error: "winback sequence not found" }, { status: 404 });
    }
    if ((seq as { kind?: string }).kind !== "winback") {
      return NextResponse.json(
        { error: "sequence must be a win-back sequence (kind='winback')" },
        { status: 400 },
      );
    }
  }

  try {
    const admin = supabaseAdmin();
    const { data, error } = await admin
      .from("growth_settings")
      .upsert({ account_id: ctx.accountId, ...patch }, { onConflict: "account_id" })
      .select(COLUMNS)
      .single();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ settings: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
