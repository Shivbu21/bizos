// Follow-up sequences — list (member) and create (agent+).

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const SEQ_COLUMNS =
  "id, account_id, name, description, kind, active, daily_send_cap, quiet_start, quiet_end, timezone, created_at, updated_at";

function validHhmm(v: unknown): v is string {
  return (
    typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())
  );
}

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("followup_sequences")
      .select(SEQ_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ sequences: data ?? [] });
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

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  if (body.quiet_start !== undefined && !validHhmm(body.quiet_start)) {
    return NextResponse.json({ error: "quiet_start must be HH:MM (24h)" }, { status: 400 });
  }
  if (body.quiet_end !== undefined && !validHhmm(body.quiet_end)) {
    return NextResponse.json({ error: "quiet_end must be HH:MM (24h)" }, { status: 400 });
  }
  const dailySendCap =
    body.daily_send_cap === undefined ? 50 : Number(body.daily_send_cap);
  if (!Number.isInteger(dailySendCap) || dailySendCap < 0) {
    return NextResponse.json(
      { error: "daily_send_cap must be a non-negative integer" },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();
  const insert: Record<string, unknown> = {
    account_id: ctx.accountId,
    name,
    description:
      typeof body.description === "string" ? body.description.trim() || null : null,
    active: body.active === undefined ? true : !!body.active,
    daily_send_cap: dailySendCap,
    quiet_start: body.quiet_start ?? "21:00",
    quiet_end: body.quiet_end ?? "09:00",
    timezone:
      typeof body.timezone === "string" && body.timezone.trim()
        ? body.timezone.trim()
        : "Asia/Kolkata",
    created_by: ctx.userId,
  };

  const { data, error } = await admin
    .from("followup_sequences")
    .insert(insert)
    .select(SEQ_COLUMNS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ sequence: data }, { status: 201 });
}
