// Lead score persistence + signal gathering.
//
// Scores are cached in `lead_scores` and recomputed on lead events:
// new capture (ingest hook), inbound WhatsApp message (webhook
// hook), and the manual backfill endpoint. All recompute paths are
// best-effort — scoring must never break ingestion or webhooks.
//
// Contact↔lead linkage for engagement signals: leads and contacts
// are separate entities, so engagement is attributed by phone-suffix
// match (the same dedup convention as Module 1). Documented
// honestly in MODULE5.md.

import { scoreLead, type LeadScoreInput } from "./scoring";
import { phoneSuffix } from "@/lib/lead-capture/ingest";

type AdminClient = ReturnType<
  typeof import("@/lib/automations/admin-client").supabaseAdmin
>;

export interface LeadSignals extends LeadScoreInput {
  leadId: string;
}

/** Gather scoring signals for one lead. */
export async function gatherLeadSignals(
  admin: AdminClient,
  accountId: string,
  leadId: string,
): Promise<LeadSignals | null> {
  const { data: lead } = await admin
    .from("leads")
    .select("id, source, name, phone, email, status")
    .eq("id", leadId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!lead) return null;
  const l = lead as {
    id: string;
    source: string | null;
    name: string | null;
    phone: string | null;
    email: string | null;
    status: string | null;
  };

  // Engagement: inbound customer messages on conversations whose
  // contact's phone matches the lead's phone suffix.
  let inboundMessageCount = 0;
  let lastInboundAt: string | null = null;
  const suffix = phoneSuffix(l.phone);
  if (suffix) {
    const { data: contacts } = await admin
      .from("contacts")
      .select("id")
      .eq("account_id", accountId)
      .like("phone", `%${suffix}`)
      .limit(25);
    const contactIds = (contacts ?? []).map((c) => c.id as string);
    if (contactIds.length > 0) {
      const { data: convs } = await admin
        .from("conversations")
        .select("id")
        .eq("account_id", accountId)
        .in("contact_id", contactIds)
        .limit(100);
      const convIds = (convs ?? []).map((c) => c.id as string);
      if (convIds.length > 0) {
        const { count } = await admin
          .from("messages")
          .select("id", { count: "exact", head: true })
          .in("conversation_id", convIds)
          .eq("sender_type", "customer");
        inboundMessageCount = count ?? 0;
        const { data: latest } = await admin
          .from("messages")
          .select("created_at")
          .in("conversation_id", convIds)
          .eq("sender_type", "customer")
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        lastInboundAt = (latest as { created_at?: string } | null)?.created_at ?? null;
      }
    }
  }

  return {
    leadId: l.id,
    source: l.source,
    inboundMessageCount,
    lastInboundAt,
    name: l.name,
    phone: l.phone,
    email: l.email,
    status: l.status,
  };
}

/** Recompute and persist one lead's score. Returns the score, or
 *  null when the lead doesn't exist. */
export async function recomputeLeadScore(
  admin: AdminClient,
  accountId: string,
  leadId: string,
  now: Date = new Date(),
): Promise<number | null> {
  const signals = await gatherLeadSignals(admin, accountId, leadId);
  if (!signals) return null;
  const { score, breakdown } = scoreLead(signals, now);
  const { error } = await admin.from("lead_scores").upsert(
    {
      account_id: accountId,
      lead_id: leadId,
      score,
      breakdown: breakdown as unknown as Record<string, unknown>,
      computed_at: now.toISOString(),
    },
    { onConflict: "account_id,lead_id" },
  );
  if (error) throw new Error(`lead_scores upsert failed: ${error.message}`);
  return score;
}

/** Recompute scores for all leads matching a phone number
 *  (WhatsApp webhook hook). Best-effort — never throws. */
export async function recomputeScoresForPhone(
  admin: AdminClient,
  accountId: string,
  phone: string | null,
): Promise<void> {
  try {
    const suffix = phoneSuffix(phone);
    if (!suffix) return;
    const { data: leads } = await admin
      .from("leads")
      .select("id")
      .eq("account_id", accountId)
      .like("phone", `%${suffix}`)
      .limit(25);
    for (const l of leads ?? []) {
      try {
        await recomputeLeadScore(admin, accountId, l.id as string);
      } catch {
        /* per-lead failure — continue */
      }
    }
  } catch {
    /* never break the webhook */
  }
}

/** Recompute scores for every lead in the account (backfill).
 *  Returns counts; continues past individual failures. */
export async function backfillLeadScores(
  admin: AdminClient,
  accountId: string,
): Promise<{ total: number; ok: number; failed: number }> {
  const out = { total: 0, ok: 0, failed: 0 };
  let page = 0;
  const PAGE = 200;
  for (;;) {
    const { data: leads, error } = await admin
      .from("leads")
      .select("id")
      .eq("account_id", accountId)
      .order("created_at", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error || !leads || leads.length === 0) break;
    out.total += leads.length;
    for (const l of leads) {
      try {
        await recomputeLeadScore(admin, accountId, l.id as string);
        out.ok += 1;
      } catch {
        out.failed += 1;
      }
    }
    if (leads.length < PAGE) break;
    page += 1;
  }
  return out;
}
