// Single follow-up sequence: read (member), update (agent+), delete (admin+).

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const SEQ_COLUMNS =
  "id, account_id, name, description, active, daily_send_cap, quiet_start, quiet_end, timezone, created_at, updated_at";
const STEP_COLUMNS =
  "id, account_id, sequence_id, step_order, day_offset, channel, message_template, fallback, created_at";

function validHhmm(v: unknown): v is string {
  return (
    typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim())
  );
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data: sequence, error } = await supabase
      .from("followup_sequences")
      .select(SEQ_COLUMNS)
      .eq("id", id)
      .single();
    if (error || !sequence) {
      return NextResponse.json({ error: "Sequence not found" }, { status: 404 });
    }
    const { data: steps } = await supabase
      .from("sequence_steps")
      .select(STEP_COLUMNS)
      .eq("sequence_id", id)
      .order("step_order", { ascending: true });
    return NextResponse.json({ sequence, steps: steps ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    patch.name = name;
  }
  if (body.description !== undefined) {
    patch.description =
      typeof body.description === "string" ? body.description.trim() || null : null;
  }
  if (body.active !== undefined) patch.active = !!body.active;
  if (body.daily_send_cap !== undefined) {
    const cap = Number(body.daily_send_cap);
    if (!Number.isInteger(cap) || cap < 0) {
      return NextResponse.json(
        { error: "daily_send_cap must be a non-negative integer" },
        { status: 400 },
      );
    }
    patch.daily_send_cap = cap;
  }
  for (const key of ["quiet_start", "quiet_end"] as const) {
    if (body[key] !== undefined) {
      if (!validHhmm(body[key])) {
        return NextResponse.json({ error: `${key} must be HH:MM (24h)` }, { status: 400 });
      }
      patch[key] = body[key];
    }
  }
  if (body.timezone !== undefined) {
    if (typeof body.timezone !== "string" || !body.timezone.trim()) {
      return NextResponse.json({ error: "timezone must be a non-empty IANA name" }, { status: 400 });
    }
    patch.timezone = body.timezone.trim();
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("followup_sequences")
    .update(patch)
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .select(SEQ_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Sequence not found" }, { status: 404 });
  }
  return NextResponse.json({ sequence: data });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  const admin = supabaseAdmin();
  const { error } = await admin
    .from("followup_sequences")
    .delete()
    .eq("id", id)
    .eq("account_id", ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
