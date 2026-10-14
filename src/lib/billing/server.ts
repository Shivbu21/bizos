// Server-side billing helpers shared by the /api/billing routes.
//
// Rules enforced here (never trust client-supplied totals):
//   * line items are validated and all money math runs through
//     src/lib/billing/gst.ts (integer paise only);
//   * document + item rows are rewritten on every save so the DB
//     always holds the computed values, never the client's;
//   * invoice status is derived from money state: recording a
//     payment recomputes amount_paid and flips issued →
//     partially_paid → paid; overdue is a read-time derivation
//     (maintained by touchOverdueInvoices) rather than a stored
//     fact that can go stale.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  computeInvoice,
  paymentStatusAfter,
  type LineInput,
  type LineResult,
} from "./gst";
import { nextBillingNumber, type BillingNumberKind } from "./numbering";

export interface ParsedLine {
  description: string;
  quantity: number;
  ratePaise: number;
  gstRate: number;
}

/** Validate a raw items array from the request body. Throws on any
 *  invalid item — the route maps it to a 400. */
export function parseLineItems(raw: unknown): ParsedLine[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("items must be a non-empty array");
  }
  if (raw.length > 200) {
    throw new Error("items is limited to 200 lines per document");
  }
  return raw.map((item, i) => {
    const rec = item as Record<string, unknown>;
    const description = typeof rec.description === "string" ? rec.description.trim() : "";
    if (!description) throw new Error(`items[${i}].description is required`);
    const quantity = Number(rec.quantity ?? 1);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new Error(`items[${i}].quantity must be a positive number`);
    }
    const ratePaise = Number(rec.rate_paise ?? rec.ratePaise);
    if (!Number.isInteger(ratePaise) || ratePaise < 0) {
      throw new Error(`items[${i}].rate_paise must be a non-negative integer (paise)`);
    }
    const gstRate = Number(rec.gst_rate ?? rec.gstRate ?? 18);
    if (!Number.isFinite(gstRate) || gstRate < 0 || gstRate > 28) {
      throw new Error(`items[${i}].gst_rate must be between 0 and 28`);
    }
    return { description, quantity, ratePaise, gstRate };
  });
}

export interface BillingSettings {
  account_id: string;
  seller_name: string | null;
  seller_gstin: string | null;
  seller_state_code: string | null;
  seller_address: string | null;
  quote_prefix: string;
  invoice_prefix: string;
  receipt_prefix: string;
}

/** Load (creating on first use) the account's billing settings. */
export async function getBillingSettings(
  admin: SupabaseClient,
  accountId: string,
): Promise<BillingSettings> {
  const { data, error } = await admin
    .from("billing_settings")
    .select(
      "account_id, seller_name, seller_gstin, seller_state_code, seller_address, quote_prefix, invoice_prefix, receipt_prefix",
    )
    .eq("account_id", accountId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load billing settings: ${error.message}`);
  if (data) return data as BillingSettings;
  const { data: created, error: createError } = await admin
    .from("billing_settings")
    .insert({ account_id: accountId })
    .select(
      "account_id, seller_name, seller_gstin, seller_state_code, seller_address, quote_prefix, invoice_prefix, receipt_prefix",
    )
    .single();
  if (createError) throw new Error(`Failed to create billing settings: ${createError.message}`);
  return created as BillingSettings;
}

export async function allocateNumber(accountId: string, kind: BillingNumberKind): Promise<string> {
  return nextBillingNumber(accountId, kind);
}

/** Compute GST for a set of lines. Quotes use it for totals only
 *  (no state split stored); invoices store the full split. */
export function priceLines(
  items: ParsedLine[],
  sellerStateCode: string | null,
  placeOfSupply: string | null,
): { lines: LineResult[]; totals: ReturnType<typeof computeInvoice>["totals"] } {
  const inputs: LineInput[] = items.map((i) => ({
    description: i.description,
    quantity: i.quantity,
    ratePaise: i.ratePaise,
    gstRate: i.gstRate,
  }));
  return computeInvoice(inputs, sellerStateCode, placeOfSupply);
}

/** Insert a document's items (quote or invoice) after deleting any
 *  existing ones — saves are full rewrites, never merges. */
export async function replaceItems(
  admin: SupabaseClient,
  table: "quote_items" | "invoice_items",
  docColumn: "quote_id" | "invoice_id",
  accountId: string,
  docId: string,
  lines: LineResult[],
): Promise<void> {
  const { error: delError } = await admin.from(table).delete().eq(docColumn, docId);
  if (delError) throw new Error(`Failed to clear ${table}: ${delError.message}`);

  const rows = lines.map((l, idx) => ({
    account_id: accountId,
    [docColumn]: docId,
    description: l.description,
    quantity: l.quantity,
    rate_paise: l.ratePaise,
    gst_rate: l.gstRate,
    line_taxable_paise: l.taxablePaise,
    ...(table === "invoice_items"
      ? {
          line_cgst_paise: l.cgstPaise,
          line_sgst_paise: l.sgstPaise,
          line_igst_paise: l.igstPaise,
        }
      : {
          line_tax_paise: l.taxPaise,
        }),
    line_total_paise: l.totalPaise,
    position: idx,
  }));

  const { error: insError } = await admin.from(table).insert(rows);
  if (insError) throw new Error(`Failed to save ${table}: ${insError.message}`);
}

/** Recompute an invoice's amount_paid from its payments and flip the
 *  status. Called after every payment insert/delete. */
export async function refreshInvoicePaymentState(
  admin: SupabaseClient,
  accountId: string,
  invoiceId: string,
): Promise<{ status: string; amount_paid_paise: number; total_paise: number }> {
  const { data: invoice, error: invError } = await admin
    .from("invoices")
    .select("id, status, total_paise")
    .eq("id", invoiceId)
    .eq("account_id", accountId)
    .single();
  if (invError || !invoice) throw new Error("Invoice not found");

  const { data: payments, error: payError } = await admin
    .from("payments")
    .select("amount_paise")
    .eq("invoice_id", invoiceId)
    .eq("account_id", accountId);
  if (payError) throw new Error(`Failed to sum payments: ${payError.message}`);

  const amountPaid = (payments ?? []).reduce((s, p) => s + (p.amount_paise as number), 0);
  let status = invoice.status as string;
  if (status === "issued" || status === "partially_paid" || status === "paid" || status === "overdue") {
    const moneyStatus = paymentStatusAfter(invoice.total_paise as number, amountPaid);
    status = moneyStatus === "issued" ? "issued" : moneyStatus;
  }

  const { error: updError } = await admin
    .from("invoices")
    .update({ amount_paid_paise: amountPaid, status })
    .eq("id", invoiceId)
    .eq("account_id", accountId);
  if (updError) throw new Error(`Failed to update invoice: ${updError.message}`);

  return { status, amount_paid_paise: amountPaid, total_paise: invoice.total_paise as number };
}

/** Flip issued/partially_paid invoices whose due date has passed to
 *  overdue. Idempotent; called on invoice reads so the status can't
 *  go stale without a cron job. */
export async function touchOverdueInvoices(
  admin: SupabaseClient,
  accountId: string,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await admin
    .from("invoices")
    .update({ status: "overdue" })
    .eq("account_id", accountId)
    .in("status", ["issued", "partially_paid"])
    .lt("due_at", today);
}

/** Quote → invoice conversion mapping. Only the line economics carry
 *  over; GST is recomputed against the invoice's states so the
 *  snapshot is correct at conversion time. */
export function quoteLinesToInvoiceInput(
  quoteItems: Array<{ description: string; quantity: number; rate_paise: number; gst_rate: number }>,
): ParsedLine[] {
  return quoteItems.map((i) => ({
    description: i.description,
    quantity: Number(i.quantity),
    ratePaise: i.rate_paise,
    gstRate: Number(i.gst_rate),
  }));
}
