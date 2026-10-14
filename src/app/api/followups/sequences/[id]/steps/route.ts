// Sequence steps — list (member) and add (agent+).
//
// step_order is assigned as max(existing)+1 when not supplied.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const STEP_COLUMNS =
  "id, account_id, sequence_id, step_order, day_offset, channel, message_template, fallback, created_at";

async function sequenceOwned(
  admin: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  sequenceId: string,
) {
  const { data, error } = await admin
    .from("followup_sequences")
    .select("id")
    .eq("id", sequenceId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (error || !data) return null;
  return data;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("sequence_steps")
      .select(STEP_COLUMNS)
      .eq("sequence_id", id)
      .order("step_order", { ascending: true });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ steps: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: sequenceId } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const template =
    typeof body.message_template === "string" ? body.message_template.trim() : "";
  if (!template) {
    return NextResponse.json({ error: "message_template is required" }, { status: 400 });
  }
  const dayOffset = Number(body.day_offset);
  if (!Number.isInteger(dayOffset) || dayOffset < 0) {
    return NextResponse.json(
      { error: "day_offset must be a non-negative integer" },
      { status: 400 },
    );
  }
  if (body.channel !== undefined && body.channel !== "whatsapp") {
    return NextResponse.json({ error: "channel must be 'whatsapp'" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  if (!(await sequenceOwned(admin, ctx.accountId, sequenceId))) {
    return NextResponse.json({ error: "Sequence not found" }, { status: 404 });
  }

  const { data: existing } = await admin
    .from("sequence_steps")
    .select("step_order")
    .eq("sequence_id", sequenceId)
    .order("step_order", { ascending: false })
    .limit(1);
  const nextOrder =
    body.step_order === undefined
      ? (existing?.[0]?.step_order ?? -1) + 1
      : Number(body.step_order);
  if (!Number.isInteger(nextOrder) || nextOrder < 0) {
    return NextResponse.json(
      { error: "step_order must be a non-negative integer" },
      { status: 400 },
    );
  }

  const { data, error } = await admin
    .from("sequence_steps")
    .insert({
      account_id: ctx.accountId,
      sequence_id: sequenceId,
      step_order: nextOrder,
      day_offset: dayOffset,
      channel: "whatsapp",
      message_template: template,
      fallback:
        typeof body.fallback === "string" ? body.fallback.trim() || null : null,
    })
    .select(STEP_COLUMNS)
    .single();
  if (error) {
    const conflict = (error.message ?? "").includes("duplicate")
      ? "a step with that order already exists"
      : error.message;
    return NextResponse.json({ error: conflict }, { status: 409 });
  }
  return NextResponse.json({ step: data }, { status: 201 });
}
