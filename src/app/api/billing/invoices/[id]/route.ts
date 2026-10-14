// Single invoice: read (any member), edit draft (agent+), delete
// draft (admin+). Reads include items, payments, and the derived
// amount-due; overdue is maintained on read.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { amountDuePaise } from "@/lib/billing/gst";
import { parseLineItems, priceLines, replaceItems, touchOverdueInvoices } from "@/lib/billing/server";

const INVOICE_COLUMNS =
  "id, account_id, number, quote_id, lead_id, status, seller_name, seller_gstin, seller_state_code, seller_address, buyer_name, buyer_gstin, buyer_address, place_of_supply, reverse_charge, currency, subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise, amount_paid_paise, issued_at, due_at, notes, created_at, updated_at";
const ITEM_COLUMNS =
  "id, description, quantity, rate_paise, gst_rate, line_taxable_paise, line_cgst_paise, line_sgst_paise, line_igst_paise, line_total_paise, position";
const PAYMENT_COLUMNS =
  "id, receipt_number, amount_paise, method, reference, received_at, created_at";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase, accountId } = await getCurrentAccount();
    try {
      await touchOverdueInvoices(supabaseAdmin(), accountId);
    } catch { /* non-fatal */ }
    const { data: invoice, error } = await supabase.from("invoices").select(INVOICE_COLUMNS).eq("id", id).single();
    if (error || !invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
    const { data: items } = await supabase
      .from("invoice_items")
      .select(ITEM_COLUMNS)
      .eq("invoice_id", id)
      .order("position");
    const { data: payments } = await supabase
      .from("payments")
      .select(PAYMENT_COLUMNS)
      .eq("invoice_id", id)
      .order("received_at", { ascending: false });
    return NextResponse.json({
      invoice,
      items: items ?? [],
      payments: payments ?? [],
      amount_due_paise: amountDuePaise(invoice.total_paise, invoice.amount_paid_paise),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

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

  const admin = supabaseAdmin();
  const { data: existing, error: fetchError } = await admin
    .from("invoices")
    .select("id, status, seller_state_code")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (fetchError || !existing) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (existing.status !== "draft") {
    return NextResponse.json({ error: "Only draft invoices can be edited" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const update: Record<string, unknown> = {};
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  for (const key of [
    "buyer_name", "buyer_gstin", "buyer_address", "seller_name", "seller_gstin",
    "seller_state_code", "seller_address", "place_of_supply", "notes",
  ] as const) {
    if (body[key] !== undefined) {
      if (key === "buyer_name" && !str(body[key])) {
        return NextResponse.json({ error: "buyer_name cannot be empty" }, { status: 400 });
      }
      update[key] = str(body[key]);
    }
  }
  if (body.reverse_charge !== undefined) update.reverse_charge = body.reverse_charge === true;
  if (typeof body.due_at === "string") update.due_at = body.due_at || null;

  if (body.items !== undefined) {
    let items;
    try {
      items = parseLineItems(body.items);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid items" }, { status: 400 });
    }
    const sellerState = (update.seller_state_code as string | null) ?? existing.seller_state_code;
    const placeOfSupply = (update.place_of_supply as string | null) ?? sellerState;
    const { lines, totals } = priceLines(items, sellerState, placeOfSupply);
    update.subtotal_paise = totals.subtotalPaise;
    update.cgst_paise = totals.cgstPaise;
    update.sgst_paise = totals.sgstPaise;
    update.igst_paise = totals.igstPaise;
    update.total_paise = totals.totalPaise;
    try {
      await replaceItems(admin, "invoice_items", "invoice_id", ctx.accountId, id, lines);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save items" }, { status: 500 });
    }
  }

  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true });

  const { data, error } = await admin
    .from("invoices")
    .update(update)
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .select(INVOICE_COLUMNS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ invoice: data });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  const admin = supabaseAdmin();
  const { data: existing } = await admin
    .from("invoices")
    .select("id, status")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (!existing) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (existing.status !== "draft") {
    return NextResponse.json({ error: "Only draft invoices can be deleted" }, { status: 409 });
  }

  const { error } = await admin.from("invoices").delete().eq("id", id).eq("account_id", ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
