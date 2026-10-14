// Win-back automation — dormant-customer detection + enrollment into
// a win-back sequence (a normal Module 3 followup_sequences row with
// kind='winback').
//
// Runs from the cron route (src/app/api/cron/followups/route.ts) after
// the drip worker. All sends go through the existing Module 3 engine,
// so quiet hours, daily caps, opt-outs, and reply-pause apply
// unchanged.
//
// Dormancy attribution (documented honestly — see MODULE5.md):
//   - Messaging activity is per-contact and exact (inbound customer
//     messages via conversations).
//   - Commercial activity (invoices/payments) links to leads, not
//     contacts, so it is attributed through the contact↔lead links
//     recorded by follow-up enrollments. Contacts never linked to a
//     lead are judged on messaging activity alone.

import { computeStepDue } from "@/lib/followups/scheduler";
import {
  isDormant,
  recentlyEngagedByWinback,
  maxInstant,
} from "./dormancy";

type AdminClient = ReturnType<
  typeof import("@/lib/automations/admin-client").supabaseAdmin
>;

interface WinbackSettings {
  account_id: string;
  winback_enabled: boolean;
  winback_dormancy_days: number;
  winback_sequence_id: string | null;
  winback_exclude_recent_days: number;
}

interface SequenceRow {
  id: string;
  account_id: string;
  active: boolean;
  kind: string;
  daily_send_cap: number;
  quiet_start: string;
  quiet_end: string;
  timezone: string;
}

export interface WinbackScanResult {
  accountsScanned: number;
  enrolled: number;
  skippedActiveJourney: number;
  skippedRecentWinback: number;
  skippedOptedOut: number;
}

const CONTACT_BATCH = 1000;

function quietOf(seq: SequenceRow) {
  return {
    quietStart: seq.quiet_start,
    quietEnd: seq.quiet_end,
    timezone: seq.timezone || "Asia/Kolkata",
  };
}

async function logEnrollment(
  admin: AdminClient,
  accountId: string,
  enrollmentId: string,
): Promise<void> {
  // Best-effort lifecycle log (mirrors Module 3's logSend shape).
  await admin.from("followup_sends").insert({
    account_id: accountId,
    enrollment_id: enrollmentId,
    step_id: null,
    status: "enrolled",
  });
}

/** Scan every account with win-back enabled and enroll dormant
 *  contacts into its win-back sequence. Safe to run on every cron
 *  tick — exclusions and the partial unique index make it
 *  idempotent. */
export async function scanWinback(
  admin: AdminClient,
  now: Date = new Date(),
): Promise<WinbackScanResult> {
  const result: WinbackScanResult = {
    accountsScanned: 0,
    enrolled: 0,
    skippedActiveJourney: 0,
    skippedRecentWinback: 0,
    skippedOptedOut: 0,
  };

  const { data: settingsRows } = await admin
    .from("growth_settings")
    .select(
      "account_id, winback_enabled, winback_dormancy_days, winback_sequence_id, winback_exclude_recent_days",
    )
    .eq("winback_enabled", true)
    .not("winback_sequence_id", "is", null);

  for (const s of (settingsRows ?? []) as WinbackSettings[]) {
    try {
      const r = await scanOneAccount(admin, s, now);
      result.accountsScanned += 1;
      result.enrolled += r.enrolled;
      result.skippedActiveJourney += r.skippedActiveJourney;
      result.skippedRecentWinback += r.skippedRecentWinback;
      result.skippedOptedOut += r.skippedOptedOut;
    } catch (err) {
      console.error("[winback] account scan failed:", s.account_id, err);
    }
  }
  return result;
}

async function scanOneAccount(
  admin: AdminClient,
  settings: WinbackSettings,
  now: Date,
): Promise<Omit<WinbackScanResult, "accountsScanned">> {
  const out = { enrolled: 0, skippedActiveJourney: 0, skippedRecentWinback: 0, skippedOptedOut: 0 };
  const accountId = settings.account_id;

  // Sequence must exist, be active, and be a win-back sequence.
  const { data: seqRow } = await admin
    .from("followup_sequences")
    .select("id, account_id, active, kind, daily_send_cap, quiet_start, quiet_end, timezone")
    .eq("id", settings.winback_sequence_id)
    .eq("account_id", accountId)
    .maybeSingle();
  const sequence = seqRow as SequenceRow | null;
  if (!sequence || !sequence.active || sequence.kind !== "winback") return out;

  // First step's day offset (0 = enroll on first cron run).
  const { data: stepRows } = await admin
    .from("sequence_steps")
    .select("day_offset")
    .eq("sequence_id", sequence.id)
    .eq("account_id", accountId)
    .order("step_order", { ascending: true })
    .limit(1);
  const firstOffset =
    stepRows && stepRows.length > 0 ? Number(stepRows[0].day_offset) || 0 : 0;
  const quiet = quietOf(sequence);

  // --- Gather per-contact activity (batched, account-scoped) ---
  const { data: contacts } = await admin
    .from("contacts")
    .select("id, created_at")
    .eq("account_id", accountId)
    .order("created_at", { ascending: true })
    .limit(CONTACT_BATCH);
  if (!contacts || contacts.length === 0) return out;
  const contactIds = contacts.map((c) => c.id as string);

  // Inbound customer messages per contact.
  const inboundByContact = new Map<string, string>();
  {
    const { data: convRows } = await admin
      .from("conversations")
      .select("id, contact_id")
      .eq("account_id", accountId)
      .in("contact_id", contactIds);
    const convToContact = new Map<string, string>();
    for (const c of convRows ?? []) {
      convToContact.set(c.id as string, c.contact_id as string);
    }
    const convIds = [...convToContact.keys()];
    if (convIds.length > 0) {
      // Paginate in chunks to stay under URL length limits.
      for (let i = 0; i < convIds.length; i += 200) {
        const chunk = convIds.slice(i, i + 200);
        const { data: msgs } = await admin
          .from("messages")
          .select("conversation_id, created_at")
          .in("conversation_id", chunk)
          .eq("sender_type", "customer")
          .order("created_at", { ascending: false })
          .limit(5000);
        for (const m of msgs ?? []) {
          const cid = convToContact.get(m.conversation_id as string);
          if (!cid) continue;
          const prev = inboundByContact.get(cid);
          const cur = m.created_at as string;
          if (!prev || cur > prev) inboundByContact.set(cid, cur);
        }
      }
    }
  }

  // Contact → linked lead ids (via follow-up enrollments).
  const leadsByContact = new Map<string, Set<string>>();
  {
    const { data: enr } = await admin
      .from("sequence_enrollments")
      .select("contact_id, lead_id")
      .eq("account_id", accountId)
      .in("contact_id", contactIds)
      .not("lead_id", "is", null);
    for (const e of enr ?? []) {
      const cid = e.contact_id as string;
      const lid = e.lead_id as string;
      if (!leadsByContact.has(cid)) leadsByContact.set(cid, new Set());
      leadsByContact.get(cid)!.add(lid);
    }
  }

  // Commercial activity per lead (invoices + payments).
  const commercialByLead = new Map<string, string>();
  {
    const { data: invoices } = await admin
      .from("invoices")
      .select("id, lead_id, created_at")
      .eq("account_id", accountId)
      .not("lead_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(5000);
    const invoiceLead = new Map<string, string>();
    for (const inv of invoices ?? []) {
      const lid = inv.lead_id as string;
      invoiceLead.set(inv.id as string, lid);
      const prev = commercialByLead.get(lid);
      const cur = inv.created_at as string;
      if (!prev || cur > prev) commercialByLead.set(lid, cur);
    }
    if (invoiceLead.size > 0) {
      const { data: payments } = await admin
        .from("payments")
        .select("invoice_id, created_at")
        .eq("account_id", accountId)
        .in("invoice_id", [...invoiceLead.keys()])
        .order("created_at", { ascending: false })
        .limit(5000);
      for (const p of payments ?? []) {
        const lid = invoiceLead.get(p.invoice_id as string);
        if (!lid) continue;
        const prev = commercialByLead.get(lid);
        const cur = p.created_at as string;
        if (!prev || cur > prev) commercialByLead.set(lid, cur);
      }
    }
  }

  // Exclusion state: active journeys (any sequence), opted-out ever,
  // recently cancelled/opted-out within the exclusion window.
  const activeContacts = new Set<string>();
  const optedOutContacts = new Set<string>();
  const recentTerminalAt = new Map<string, string>();
  {
    const { data: enr } = await admin
      .from("sequence_enrollments")
      .select("contact_id, status, updated_at")
      .eq("account_id", accountId)
      .in("contact_id", contactIds)
      .in("status", ["active", "paused", "opted_out", "cancelled"]);
    for (const e of enr ?? []) {
      const cid = e.contact_id as string;
      const st = e.status as string;
      if (st === "active" || st === "paused") activeContacts.add(cid);
      if (st === "opted_out") optedOutContacts.add(cid);
      if (st === "opted_out" || st === "cancelled") {
        const prev = recentTerminalAt.get(cid);
        const cur = e.updated_at as string;
        if (!prev || cur > prev) recentTerminalAt.set(cid, cur);
      }
    }
  }

  // --- Enroll the dormant ---
  for (const contact of contacts as Array<{ id: string; created_at: string }>) {
    const cid = contact.id;
    if (optedOutContacts.has(cid)) {
      out.skippedOptedOut += 1;
      continue;
    }
    if (activeContacts.has(cid)) {
      out.skippedActiveJourney += 1;
      continue;
    }
    const lastTerminal = recentTerminalAt.get(cid) ?? null;
    if (
      recentlyEngagedByWinback(lastTerminal, settings.winback_exclude_recent_days, now)
    ) {
      out.skippedRecentWinback += 1;
      continue;
    }

    const linkedLeads = leadsByContact.get(cid);
    let commercialMax: string | null = null;
    if (linkedLeads) {
      for (const lid of linkedLeads) {
        commercialMax = maxInstant(commercialMax, commercialByLead.get(lid) ?? null);
      }
    }
    const lastActivity = maxInstant(
      inboundByContact.get(cid) ?? null,
      commercialMax,
    );
    if (
      !isDormant(
        { lastActivityAt: lastActivity, createdAt: contact.created_at },
        settings.winback_dormancy_days,
        now,
      )
    ) {
      continue;
    }

    // Enroll (partial unique index on active journeys guards races;
    // a conflict here just means someone else enrolled first).
    const dueAt = computeStepDue(now, firstOffset, quiet);
    const { data: inserted, error } = await admin
      .from("sequence_enrollments")
      .insert({
        account_id: accountId,
        sequence_id: sequence.id,
        contact_id: cid,
        status: "active",
        current_step: 0,
        enrolled_at: now.toISOString(),
        next_due_at: dueAt.toISOString(),
      })
      .select("id")
      .single();
    if (error || !inserted) continue;
    await logEnrollment(admin, accountId, inserted.id as string).catch(() => {});
    out.enrolled += 1;
  }

  return out;
}
