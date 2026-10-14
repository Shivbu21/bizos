// Follow-up enrollments — list (member) and enroll (agent+).
//
// Enrolling starts the journey at step_order 0; next_due_at is the
// step-0 day offset pushed past the sequence's quiet hours.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { computeStepDue } from "@/lib/followups/scheduler";

const ENROLL_COLUMNS =
  "id, account_id, sequence_id, contact_id, lead_id, status, current_step, enrolled_at, next_due_at, last_sent_at, paused_at, completed_at, created_at";

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    const sequenceId = searchParams.get("sequence_id");

    let query = supabase
      .from("sequence_enrollments")
      .select(
        `${ENROLL_COLUMNS}, contacts(id, name, phone), followup_sequences(id, name)`,
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (status) query = query.eq("status", status);
    if (sequenceId) query = query.eq("sequence_id", sequenceId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ enrollments: data ?? [] });
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

  const sequenceId = typeof body.sequence_id === "string" ? body.sequence_id : "";
  const contactId = typeof body.contact_id === "string" ? body.contact_id : "";
  if (!sequenceId || !contactId) {
    return NextResponse.json(
      { error: "sequence_id and contact_id are required" },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();
  const now = new Date();

  // Sequence must exist on this account.
  const { data: sequence } = await admin
    .from("followup_sequences")
    .select("id, quiet_start, quiet_end, timezone")
    .eq("id", sequenceId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!sequence) {
    return NextResponse.json({ error: "Sequence not found" }, { status: 404 });
  }

  // Contact must exist on this account.
  const { data: contact } = await admin
    .from("contacts")
    .select("id, phone")
    .eq("id", contactId)
    .eq("account_id", ctx.accountId)
    .maybeSingle();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  // Optional lead back-link (Module 1) — must also be this account's.
  let leadId: string | null = null;
  if (typeof body.lead_id === "string" && body.lead_id) {
    const { data: lead } = await admin
      .from("leads")
      .select("id")
      .eq("id", body.lead_id)
      .eq("account_id", ctx.accountId)
      .maybeSingle();
    if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
    leadId = lead.id as string;
  }

  // First step determines the initial due date.
  const { data: firstStep } = await admin
    .from("sequence_steps")
    .select("day_offset")
    .eq("sequence_id", sequenceId)
    .eq("step_order", 0)
    .maybeSingle();
  if (!firstStep) {
    return NextResponse.json(
      { error: "Add at least one step (step_order 0) before enrolling" },
      { status: 400 },
    );
  }

  const nextDue = computeStepDue(
    now,
    (firstStep as { day_offset: number }).day_offset,
    {
      quietStart: (sequence as { quiet_start: string }).quiet_start,
      quietEnd: (sequence as { quiet_end: string }).quiet_end,
      timezone: (sequence as { timezone: string }).timezone,
    },
  );

  const { data: enrollment, error } = await admin
    .from("sequence_enrollments")
    .insert({
      account_id: ctx.accountId,
      sequence_id: sequenceId,
      contact_id: contactId,
      lead_id: leadId,
      status: "active",
      current_step: 0,
      enrolled_at: now.toISOString(),
      next_due_at: nextDue.toISOString(),
    })
    .select(ENROLL_COLUMNS)
    .single();

  if (error) {
    if ((error.message ?? "").toLowerCase().includes("duplicate")) {
      return NextResponse.json(
        { error: "Contact is already enrolled in this sequence" },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await admin.from("followup_sends").insert({
    account_id: ctx.accountId,
    enrollment_id: (enrollment as { id: string }).id,
    step_id: null,
    status: "enrolled",
  });

  return NextResponse.json({ enrollment }, { status: 201 });
}
