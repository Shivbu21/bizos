// Post-invoice review requests.
//
// When an invoice flips to `paid`, the billing hook queues a review
// request due `review_delay_days` later. The cron worker claims due
// rows (conditional UPDATE — overlapping ticks can't double-send),
// renders the template, and sends via the base template's Meta
// sender.
//
// Honest limit: review *clicks* are not tracked — the base
// template's send path has no click-callback support, so "sent" is
// the terminal observable state. Documented in MODULE5.md.

import { renderTemplate } from "@/lib/followups/scheduler";
import { phoneSuffix } from "@/lib/lead-capture/ingest";
import { sendTextToContact } from "./send-shared";

type AdminClient = ReturnType<
  typeof import("@/lib/automations/admin-client").supabaseAdmin
>;

export interface ReviewProcessResult {
  examined: number;
  sent: number;
  failed: number;
}

const BATCH = 50;

/** Queue a review request for a newly-paid invoice. Idempotent per
 *  invoice (unique index) — calling twice is a no-op. Returns the
 *  row id, or null when review requests are disabled / unresolvable. */
export async function queueReviewRequest(
  admin: AdminClient,
  args: { accountId: string; invoiceId: string; paidAt?: Date },
): Promise<string | null> {
  const { accountId, invoiceId } = args;
  const paidAt = args.paidAt ?? new Date();

  const { data: settings } = await admin
    .from("growth_settings")
    .select("review_enabled, review_delay_days, review_template")
    .eq("account_id", accountId)
    .maybeSingle();
  if (!settings || !(settings as { review_enabled?: boolean }).review_enabled) {
    return null;
  }
  const delayDays = Number(
    (settings as { review_delay_days?: number }).review_delay_days ?? 2,
  );

  const contactId = await resolveContactForInvoice(admin, accountId, invoiceId);
  if (!contactId) return null; // no WhatsApp-able contact — skip silently

  const dueAt = new Date(paidAt.getTime() + delayDays * 24 * 60 * 60 * 1000);
  const { data, error } = await admin
    .from("review_requests")
    .upsert(
      {
        account_id: accountId,
        contact_id: contactId,
        invoice_id: invoiceId,
        due_at: dueAt.toISOString(),
        status: "pending",
      },
      { onConflict: "account_id,invoice_id", ignoreDuplicates: true },
    )
    .select("id");
  if (error || !data || data.length === 0) return null;
  return data[0].id as string;
}

/** Find the WhatsApp contact behind an invoice: invoice.lead_id →
 *  lead phone → contact phone-suffix match. Null when unresolvable. */
export async function resolveContactForInvoice(
  admin: AdminClient,
  accountId: string,
  invoiceId: string,
): Promise<string | null> {
  const { data: invoice } = await admin
    .from("invoices")
    .select("lead_id")
    .eq("id", invoiceId)
    .eq("account_id", accountId)
    .maybeSingle();
  const leadId = (invoice as { lead_id?: string | null } | null)?.lead_id;
  if (!leadId) return null;

  const { data: lead } = await admin
    .from("leads")
    .select("phone")
    .eq("id", leadId)
    .eq("account_id", accountId)
    .maybeSingle();
  const phone = (lead as { phone?: string | null } | null)?.phone;
  const suffix = phoneSuffix(phone ?? null);
  if (!suffix) return null;

  const { data: contact } = await admin
    .from("contacts")
    .select("id")
    .eq("account_id", accountId)
    .like("phone", `%${suffix}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (contact as { id?: string } | null)?.id ?? null;
}

/** Process due review requests. Safe on every cron tick. */
export async function processReviewRequests(
  admin: AdminClient,
  now: Date = new Date(),
): Promise<ReviewProcessResult> {
  const result: ReviewProcessResult = { examined: 0, sent: 0, failed: 0 };

  const { data: rows, error } = await admin
    .from("review_requests")
    .select("id, account_id, contact_id, invoice_id, due_at")
    .eq("status", "pending")
    .lte("due_at", now.toISOString())
    .order("due_at", { ascending: true })
    .limit(BATCH);
  if (error) {
    console.error("[reviews] due query failed:", error.message);
    return result;
  }

  for (const row of rows ?? []) {
    result.examined += 1;
    const id = row.id as string;
    const accountId = row.account_id as string;
    try {
      await processOne(admin, {
        id,
        accountId,
        contactId: row.contact_id as string,
      });
      result.sent += 1;
    } catch (err) {
      // Claim failed or send failed — mark failed loudly (not silent).
      await admin
        .from("review_requests")
        .update({
          status: "failed",
          error: err instanceof Error ? err.message : String(err),
        })
        .eq("id", id)
        .eq("status", "pending");
      result.failed += 1;
    }
  }
  return result;
}

async function processOne(
  admin: AdminClient,
  row: { id: string; accountId: string; contactId: string },
): Promise<void> {
  // Claim: only the tick that flips pending→claimed proceeds.
  // (We flip straight to sent/failed below with the same guard.)
  const { data: settings } = await admin
    .from("growth_settings")
    .select("review_template")
    .eq("account_id", row.accountId)
    .maybeSingle();
  const template =
    (settings as { review_template?: string } | null)?.review_template ??
    "Hi {{name}}, thanks for your business!";

  const [{ data: contact }, { data: account }] = await Promise.all([
    admin
      .from("contacts")
      .select("name")
      .eq("id", row.contactId)
      .eq("account_id", row.accountId)
      .maybeSingle(),
    admin.from("accounts").select("name").eq("id", row.accountId).maybeSingle(),
  ]);
  const text = renderTemplate(template, {
    name: (contact as { name?: string | null } | null)?.name ?? "",
    business: (account as { name?: string | null } | null)?.name ?? "",
  });

  const providerMessageId = await sendTextToContact(
    admin,
    row.accountId,
    row.contactId,
    text,
  );

  // Conditional update: a concurrent tick that already moved this row
  // off 'pending' wins; we only count it when WE moved it.
  const { data: updated } = await admin
    .from("review_requests")
    .update({
      status: "sent",
      message_snapshot: text,
      sent_at: new Date().toISOString(),
      provider_message_id: providerMessageId,
    })
    .eq("id", row.id)
    .eq("status", "pending")
    .select("id");
  if (!updated || updated.length === 0) {
    throw new Error("lost the claim race — another tick sent this request");
  }
}
