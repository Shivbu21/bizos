// Follow-up send engine — processes due drip enrollments.
//
// Called by POST /api/cron/followups (secret-verified). Sends go
// through the base template's WhatsApp sender
// (`engineSendText` in src/lib/automations/meta-send.ts) — this
// module does NOT reimplement Meta sending.
//
// Concurrency safety: each due enrollment is claimed with a
// conditional UPDATE (status='active' AND next_due_at <= now) that
// pushes next_due_at forward before any send attempt, so two
// overlapping cron invocations can't double-send the same step.
//
// Failure policy: a failed send is logged ('failed') and retried at
// next_due_at = now + 15 minutes. Inbox opt-outs and human replies
// are handled by inbound.ts, not here.

import { engineSendText } from "@/lib/automations/meta-send";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  computeStepDue,
  isQuietHours,
  renderTemplate,
  selectDueEnrollments,
  startOfDayInZone,
  withinDailyCap,
  type QuietConfig,
} from "./scheduler";

type AdminClient = ReturnType<typeof supabaseAdmin>;

const CLAIM_HOLD_MINUTES = 60;
const RETRY_MINUTES = 15;
const BATCH_LIMIT = 50;

export interface ProcessResult {
  examined: number;
  sent: number;
  failed: number;
  deferredQuiet: number;
  deferredCap: number;
  completed: number;
}

interface EnrollmentRow {
  id: string;
  account_id: string;
  sequence_id: string;
  contact_id: string;
  status: string;
  current_step: number;
  enrolled_at: string;
  next_due_at: string | null;
}

interface SequenceRow {
  id: string;
  active: boolean;
  daily_send_cap: number;
  quiet_start: string;
  quiet_end: string;
  timezone: string;
}

interface StepRow {
  id: string;
  step_order: number;
  day_offset: number;
  message_template: string;
  fallback: string | null;
}

function quietOf(seq: SequenceRow): QuietConfig {
  return {
    quietStart: seq.quiet_start,
    quietEnd: seq.quiet_end,
    timezone: seq.timezone,
  };
}

async function logSend(
  admin: AdminClient,
  row: {
    account_id: string;
    enrollment_id: string;
    step_id: string | null;
    status: string;
    provider_message_id?: string | null;
    error?: string | null;
  },
): Promise<void> {
  const { error } = await admin.from("followup_sends").insert({
    account_id: row.account_id,
    enrollment_id: row.enrollment_id,
    step_id: row.step_id,
    status: row.status,
    provider_message_id: row.provider_message_id ?? null,
    error: row.error ?? null,
  });
  if (error) console.error("[followups] log insert failed:", error.message);
}

async function findOrCreateConversationId(
  admin: AdminClient,
  accountId: string,
  ownerUserId: string,
  contactId: string,
): Promise<string> {
  const { data: existing } = await admin
    .from("conversations")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data: created, error } = await admin
    .from("conversations")
    .insert({
      account_id: accountId,
      user_id: ownerUserId,
      contact_id: contactId,
      status: "open",
    })
    .select("id")
    .single();
  if (error || !created) {
    throw new Error(`could not open conversation: ${error?.message ?? "unknown"}`);
  }
  return created.id as string;
}

/** Claim a due enrollment. Returns true only if this worker won the
 *  claim (conditional UPDATE found the row still due and active). */
async function claimEnrollment(
  admin: AdminClient,
  enrollment: EnrollmentRow,
  now: Date,
): Promise<boolean> {
  const holdUntil = new Date(
    now.getTime() + CLAIM_HOLD_MINUTES * 60 * 1000,
  ).toISOString();
  const { data } = await admin
    .from("sequence_enrollments")
    .update({ next_due_at: holdUntil, updated_at: now.toISOString() })
    .eq("id", enrollment.id)
    .eq("status", "active")
    .lte("next_due_at", now.toISOString())
    .select("id")
    .maybeSingle();
  return !!data;
}

async function processOne(
  admin: AdminClient,
  enrollment: EnrollmentRow,
  now: Date,
): Promise<keyof Omit<ProcessResult, "examined">> {
  const accountId = enrollment.account_id;

  // --- sequence must exist and be active ---
  const { data: seq } = await admin
    .from("followup_sequences")
    .select("id, active, daily_send_cap, quiet_start, quiet_end, timezone")
    .eq("id", enrollment.sequence_id)
    .eq("account_id", accountId)
    .maybeSingle();
  const sequence = seq as SequenceRow | null;
  if (!sequence || !sequence.active) {
    // Park for an hour; a reactivated sequence resumes the journey.
    await admin
      .from("sequence_enrollments")
      .update({
        next_due_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", enrollment.id);
    return "failed";
  }
  const quiet = quietOf(sequence);

  // --- quiet hours: retry at window end ---
  if (isQuietHours(now, quiet)) {
    const retryAt = new Date(now.getTime() + 60 * 60 * 1000);
    await admin
      .from("sequence_enrollments")
      .update({
        next_due_at: retryAt.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", enrollment.id);
    return "deferredQuiet";
  }

  // --- steps: is the journey finished? ---
  const { data: stepRows } = await admin
    .from("sequence_steps")
    .select("id, step_order, day_offset, message_template, fallback")
    .eq("sequence_id", sequence.id)
    .eq("account_id", accountId)
    .order("step_order", { ascending: true });
  const steps = (stepRows ?? []) as StepRow[];
  const step = steps.find((s) => s.step_order === enrollment.current_step);

  if (!step) {
    // No step at this index → journey complete.
    await admin
      .from("sequence_enrollments")
      .update({
        status: "completed",
        completed_at: now.toISOString(),
        next_due_at: null,
        updated_at: now.toISOString(),
      })
      .eq("id", enrollment.id);
    await logSend(admin, {
      account_id: accountId,
      enrollment_id: enrollment.id,
      step_id: null,
      status: "completed",
    });
    return "completed";
  }

  // --- daily cap (account-local day) ---
  const dayStart = startOfDayInZone(now, quiet.timezone).toISOString();
  const { count: sentToday } = await admin
    .from("followup_sends")
    .select("id", { count: "exact", head: true })
    .eq("account_id", accountId)
    .eq("status", "sent")
    .gte("created_at", dayStart);
  if (!withinDailyCap(sentToday ?? 0, sequence.daily_send_cap)) {
    const nextDay = new Date(
      startOfDayInZone(now, quiet.timezone).getTime() + 24 * 60 * 60 * 1000,
    );
    await admin
      .from("sequence_enrollments")
      .update({
        next_due_at: nextDay.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", enrollment.id);
    return "deferredCap";
  }

  // --- contact + conversation ---
  const { data: contact } = await admin
    .from("contacts")
    .select("id, name, phone")
    .eq("id", enrollment.contact_id)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!contact?.phone) {
    await logSend(admin, {
      account_id: accountId,
      enrollment_id: enrollment.id,
      step_id: step.id,
      status: "failed",
      error: "contact missing or has no phone",
    });
    return "failed";
  }

  const { data: config } = await admin
    .from("whatsapp_config")
    .select("user_id")
    .eq("account_id", accountId)
    .maybeSingle();
  const ownerUserId = (config as { user_id?: string } | null)?.user_id;
  if (!ownerUserId) {
    await logSend(admin, {
      account_id: accountId,
      enrollment_id: enrollment.id,
      step_id: step.id,
      status: "failed",
      error: "WhatsApp not configured for this account",
    });
    await admin
      .from("sequence_enrollments")
      .update({
        next_due_at: new Date(
          now.getTime() + CLAIM_HOLD_MINUTES * 60 * 1000,
        ).toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", enrollment.id);
    return "failed";
  }

  const { data: account } = await admin
    .from("accounts")
    .select("name")
    .eq("id", accountId)
    .maybeSingle();

  const text = renderTemplate(step.message_template, {
    name: (contact as { name?: string | null }).name ?? "",
    business: (account as { name?: string | null } | null)?.name ?? "",
  });

  let conversationId: string;
  try {
    conversationId = await findOrCreateConversationId(
      admin,
      accountId,
      ownerUserId,
      enrollment.contact_id,
    );
  } catch (err) {
    await logSend(admin, {
      account_id: accountId,
      enrollment_id: enrollment.id,
      step_id: step.id,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }

  // --- send via the base template's Meta sender ---
  let providerMessageId: string;
  try {
    const result = await engineSendText({
      accountId,
      userId: ownerUserId,
      conversationId,
      contactId: enrollment.contact_id,
      text,
    });
    providerMessageId = result.whatsapp_message_id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSend(admin, {
      account_id: accountId,
      enrollment_id: enrollment.id,
      step_id: step.id,
      status: "failed",
      error: message,
    });
    // Retry in 15 minutes; repeated failures surface in the timeline.
    await admin
      .from("sequence_enrollments")
      .update({
        next_due_at: new Date(
          now.getTime() + RETRY_MINUTES * 60 * 1000,
        ).toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("id", enrollment.id);
    return "failed";
  }

  await logSend(admin, {
    account_id: accountId,
    enrollment_id: enrollment.id,
    step_id: step.id,
    status: "sent",
    provider_message_id: providerMessageId,
  });

  // --- advance the journey ---
  const nextStepIndex = enrollment.current_step + 1;
  const nextStep = steps.find((s) => s.step_order === nextStepIndex);
  if (!nextStep) {
    await admin
      .from("sequence_enrollments")
      .update({
        status: "completed",
        completed_at: now.toISOString(),
        last_sent_at: now.toISOString(),
        next_due_at: null,
        updated_at: now.toISOString(),
      })
      .eq("id", enrollment.id);
    await logSend(admin, {
      account_id: accountId,
      enrollment_id: enrollment.id,
      step_id: null,
      status: "completed",
    });
    return "completed";
  }

  const nextDue = computeStepDue(
    new Date(enrollment.enrolled_at),
    nextStep.day_offset,
    quiet,
  );
  await admin
    .from("sequence_enrollments")
    .update({
      current_step: nextStepIndex,
      last_sent_at: now.toISOString(),
      next_due_at: nextDue.toISOString(),
      updated_at: now.toISOString(),
    })
    .eq("id", enrollment.id);
  return "sent";
}

export async function processDueFollowups(
  admin: AdminClient,
  opts?: { now?: Date; limit?: number },
): Promise<ProcessResult> {
  const now = opts?.now ?? new Date();
  const limit = opts?.limit ?? BATCH_LIMIT;
  const result: ProcessResult = {
    examined: 0,
    sent: 0,
    failed: 0,
    deferredQuiet: 0,
    deferredCap: 0,
    completed: 0,
  };

  const { data: rows, error } = await admin
    .from("sequence_enrollments")
    .select(
      "id, account_id, sequence_id, contact_id, status, current_step, enrolled_at, next_due_at",
    )
    .eq("status", "active")
    .lte("next_due_at", now.toISOString())
    .order("next_due_at", { ascending: true })
    .limit(limit);

  if (error) {
    console.error("[followups] due query failed:", error.message);
    return result;
  }
  const enrollments = (rows ?? []) as EnrollmentRow[];
  result.examined = enrollments.length;

  for (const enrollment of enrollments) {
    // Fetch the sequence's quiet config for selection. Sequences are
    // few; one extra query per enrollment is acceptable at cron scale.
    const { data: seq } = await admin
      .from("followup_sequences")
      .select("quiet_start, quiet_end, timezone")
      .eq("id", enrollment.sequence_id)
      .maybeSingle();
    const quiet: QuietConfig = seq
      ? {
          quietStart: (seq as SequenceRow).quiet_start,
          quietEnd: (seq as SequenceRow).quiet_end,
          timezone: (seq as SequenceRow).timezone,
        }
      : { quietStart: "21:00", quietEnd: "09:00", timezone: "Asia/Kolkata" };

    const { due } = selectDueEnrollments(
      [
        {
          status: enrollment.status,
          nextDueAt: enrollment.next_due_at,
          currentStep: enrollment.current_step,
        },
      ],
      now,
      quiet,
    );
    if (due.length === 0) {
      result.deferredQuiet += 1;
      continue;
    }

    const claimed = await claimEnrollment(admin, enrollment, now);
    if (!claimed) continue; // another worker got it

    try {
      const outcome = await processOne(admin, enrollment, now);
      result[outcome] += 1;
    } catch (err) {
      console.error("[followups] processOne threw:", err);
      result.failed += 1;
    }
  }

  return result;
}
