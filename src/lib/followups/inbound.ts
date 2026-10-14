// Follow-up inbound handling — reply detection and opt-out.
//
// Called from the WhatsApp webhook's per-message path after the
// inbound message is stored. A real human reply must never be
// talked over by a drip: any active enrollment for the contact is
// paused. STOP / UNSUBSCRIBE opts the contact out permanently.
//
// Opt-out is terminal: applyFollowupInbound only ever moves
// enrollments active/paused → opted_out, and the scheduler never
// selects opted_out enrollments. Every transition is logged to
// followup_sends (append-only) so the enrollment timeline shows
// exactly why a journey stopped.

import { inboundDisposition } from "./scheduler";

interface AdminClient {
  from: (table: string) => any;
}

interface FollowupInboundArgs {
  admin: AdminClient;
  accountId: string;
  contactId: string;
  /** Plain-text body of the inbound message (may be null for media). */
  text: string | null;
}

export interface FollowupInboundResult {
  disposition: "opt_out" | "pause" | "none";
  affected: number;
}

export async function applyFollowupInbound(
  args: FollowupInboundArgs,
): Promise<FollowupInboundResult> {
  const { admin, accountId, contactId, text } = args;

  const { data: active, error } = await admin
    .from("sequence_enrollments")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .in("status", ["active", "paused"]);

  if (error) {
    console.error("[followups] inbound lookup failed:", error.message);
    return { disposition: "none", affected: 0 };
  }
  const rows = (active ?? []) as Array<{ id: string }>;
  const disposition = inboundDisposition(text, rows.length);
  if (disposition === "none") return { disposition, affected: 0 };

  const now = new Date().toISOString();
  const targetStatus = disposition === "opt_out" ? "opted_out" : "paused";
  const ids = rows.map((r) => r.id);

  const patch: Record<string, unknown> = {
    status: targetStatus,
    updated_at: now,
  };
  if (disposition === "pause") patch.paused_at = now;

  const { error: updateError } = await admin
    .from("sequence_enrollments")
    .update(patch)
    .in("id", ids)
    .eq("account_id", accountId);

  if (updateError) {
    console.error("[followups] inbound status update failed:", updateError.message);
    return { disposition, affected: 0 };
  }

  // Lifecycle log rows (step_id NULL) — the timeline view reads these.
  const logStatus = disposition === "opt_out" ? "opted_out" : "paused_on_reply";
  const logs = ids.map((id) => ({
    account_id: accountId,
    enrollment_id: id,
    step_id: null,
    status: logStatus,
  }));
  const { error: logError } = await admin.from("followup_sends").insert(logs);
  if (logError) {
    console.error("[followups] inbound log insert failed:", logError.message);
  }

  return { disposition, affected: ids.length };
}
