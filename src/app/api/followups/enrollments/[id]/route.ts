// Single enrollment: detail + timeline (member), lifecycle actions
// (agent+).
//
// PATCH { action }:
//   pause   — active → paused (human takes over; resume manually)
//   resume  — paused → active, continuing at the NEXT step
//   cancel  — active/paused → cancelled (terminal)

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { computeStepDue } from "@/lib/followups/scheduler";

const ENROLL_COLUMNS =
  "id, account_id, sequence_id, contact_id, lead_id, status, current_step, enrolled_at, next_due_at, last_sent_at, paused_at, completed_at, created_at";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data: enrollment, error } = await supabase
      .from("sequence_enrollments")
      .select(
        `${ENROLL_COLUMNS}, contacts(id, name, phone), followup_sequences(id, name)`,
      )
      .eq("id", id)
      .single();
    if (error || !enrollment) {
      return NextResponse.json({ error: "Enrollment not found" }, { status: 404 });
    }
    const { data: timeline } = await supabase
      .from("followup_sends")
      .select(
        "id, step_id, status, provider_message_id, error, created_at, sequence_steps(step_order, message_template)",
      )
      .eq("enrollment_id", id)
      .order("created_at", { ascending: true });
    return NextResponse.json({ enrollment, timeline: timeline ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

type Action = "pause" | "resume" | "cancel";

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
  const action = body?.action as Action | undefined;
  if (action !== "pause" && action !== "resume" && action !== "cancel") {
    return NextResponse.json(
      { error: "action must be pause, resume, or cancel" },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();
  const now = new Date();

  const { data: enrollment } = await admin
    .from("sequence_enrollments")
    .select(
      "id, sequence_id, contact_id, status, current_step, enrolled_at",
    )
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!enrollment) {
    return NextResponse.json({ error: "Enrollment not found" }, { status: 404 });
  }
  const row = enrollment as {
    id: string;
    sequence_id: string;
    contact_id: string;
    status: string;
    current_step: number;
    enrolled_at: string;
  };

  const log = (status: string) =>
    admin.from("followup_sends").insert({
      account_id: ctx.accountId,
      enrollment_id: row.id,
      step_id: null,
      status,
    });

  if (action === "pause") {
    if (row.status !== "active") {
      return NextResponse.json({ error: `Cannot pause a ${row.status} enrollment` }, { status: 409 });
    }
    await admin
      .from("sequence_enrollments")
      .update({
        status: "paused",
        paused_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", row.id);
    await log("paused");
    return NextResponse.json({ ok: true, status: "paused" });
  }

  if (action === "cancel") {
    if (row.status !== "active" && row.status !== "paused") {
      return NextResponse.json({ error: `Cannot cancel a ${row.status} enrollment` }, { status: 409 });
    }
    await admin
      .from("sequence_enrollments")
      .update({
        status: "cancelled",
        next_due_at: null,
        updated_at: now.toISOString(),
      })
      .eq("id", row.id);
    await log("cancelled");
    return NextResponse.json({ ok: true, status: "cancelled" });
  }

  // resume — continue at the NEXT step.
  if (row.status !== "paused") {
    return NextResponse.json({ error: `Cannot resume a ${row.status} enrollment` }, { status: 409 });
  }
  const { data: sequence } = await admin
    .from("followup_sequences")
    .select("quiet_start, quiet_end, timezone")
    .eq("id", row.sequence_id)
    .maybeSingle();
  const quiet = sequence
    ? {
        quietStart: (sequence as { quiet_start: string }).quiet_start,
        quietEnd: (sequence as { quiet_end: string }).quiet_end,
        timezone: (sequence as { timezone: string }).timezone,
      }
    : { quietStart: "21:00", quietEnd: "09:00", timezone: "Asia/Kolkata" };

  const nextIndex = row.current_step + 1;
  const { data: nextStep } = await admin
    .from("sequence_steps")
    .select("day_offset")
    .eq("sequence_id", row.sequence_id)
    .eq("step_order", nextIndex)
    .maybeSingle();

  if (!nextStep) {
    await admin
      .from("sequence_enrollments")
      .update({
        status: "completed",
        completed_at: now.toISOString(),
        next_due_at: null,
        updated_at: now.toISOString(),
      })
      .eq("id", row.id);
    await log("completed");
    return NextResponse.json({ ok: true, status: "completed" });
  }

  const nextDue = computeStepDue(
    new Date(row.enrolled_at),
    (nextStep as { day_offset: number }).day_offset,
    quiet,
  );
  await admin
    .from("sequence_enrollments")
    .update({
      status: "active",
      current_step: nextIndex,
      next_due_at: nextDue.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", row.id);
  await log("resumed");
  return NextResponse.json({ ok: true, status: "active" });
}
