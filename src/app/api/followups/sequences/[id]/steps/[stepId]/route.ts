// Single sequence step — update (agent+), delete (admin+).
//
// Deleting a step does NOT renumber the survivors: enrollments store
// a 0-based current_step index, and renumbering would silently move
// in-flight journeys to a different message.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

const STEP_COLUMNS =
  "id, account_id, sequence_id, step_order, day_offset, channel, message_template, fallback, created_at";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> },
) {
  const { id: sequenceId, stepId } = await params;
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if (body.message_template !== undefined) {
    const t =
      typeof body.message_template === "string" ? body.message_template.trim() : "";
    if (!t) return NextResponse.json({ error: "message_template cannot be empty" }, { status: 400 });
    patch.message_template = t;
  }
  if (body.fallback !== undefined) {
    patch.fallback =
      typeof body.fallback === "string" ? body.fallback.trim() || null : null;
  }
  if (body.day_offset !== undefined) {
    const d = Number(body.day_offset);
    if (!Number.isInteger(d) || d < 0) {
      return NextResponse.json(
        { error: "day_offset must be a non-negative integer" },
        { status: 400 },
      );
    }
    patch.day_offset = d;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from("sequence_steps")
    .update(patch)
    .eq("id", stepId)
    .eq("sequence_id", sequenceId)
    .eq("account_id", ctx.accountId)
    .select(STEP_COLUMNS)
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Step not found" }, { status: 404 });
  }
  return NextResponse.json({ step: data });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> },
) {
  const { id: sequenceId, stepId } = await params;
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  const admin = supabaseAdmin();
  const { error } = await admin
    .from("sequence_steps")
    .delete()
    .eq("id", stepId)
    .eq("sequence_id", sequenceId)
    .eq("account_id", ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
