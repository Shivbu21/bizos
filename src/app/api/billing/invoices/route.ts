// Invoices — list and create (agent+).
// GET lists the account's invoices (RLS-scoped) and maintains the
// overdue derivation: issued/partially_paid invoices past their due
// date are flipped to `overdue` (idempotent, no cron needed).
// POST creates a draft invoice with a race-safe sequential number;
// GST is computed server-side from the items.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  allocateNumber,
  getBillingSettings,
  parseLineItems,
  priceLines,
  replaceItems,
  touchOverdueInvoices,
} from "@/lib/billing/server";

const INVOICE_COLUMNS =
  "id, account_id, number, quote_id, lead_id, status, seller_name, seller_gstin, seller_state_code, seller_address, buyer_name, buyer_gstin, buyer_address, place_of_supply, reverse_charge, currency, subtotal_paise, cgst_paise, sgst_paise, igst_paise, total_paise, amount_paid_paise, issued_at, due_at, notes, created_at, updated_at";

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    let query = supabase.from("invoices").select(INVOICE_COLUMNS).order("created_at", { ascending: false }).limit(200);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    // Best-effort overdue maintenance; never fail the read for it.
    try {
      await touchOverdueInvoices(supabaseAdmin(), accountId);
    } catch { /* non-fatal */ }
    return NextResponse.json({ invoices: data ?? [] });
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

  const buyerName = typeof body.buyer_name === "string" ? body.buyer_name.trim() : "";
  if (!buyerName) return NextResponse.json({ error: "buyer_name is required" }, { status: 400 });

  let items;
  try {
    items = parseLineItems(body.items);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid items" }, { status: 400 });
  }

  const admin = supabaseAdmin();
  let settings;
  try {
    settings = await getBillingSettings(admin, ctx.accountId);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Settings failed" }, { status: 500 });
  }

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const sellerState = str(body.seller_state_code) ?? settings.seller_state_code;
  const placeOfSupply = str(body.place_of_supply) ?? sellerState;
  const { lines, totals } = priceLines(items, sellerState, placeOfSupply);

  let number: string;
  try {
    number = await allocateNumber(ctx.accountId, "invoice");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Numbering failed" }, { status: 500 });
  }

  const { data: invoice, error } = await admin
    .from("invoices")
    .insert({
      account_id: ctx.accountId,
      number,
      quote_id: typeof body.quote_id === "string" && body.quote_id ? body.quote_id : null,
      lead_id: typeof body.lead_id === "string" && body.lead_id ? body.lead_id : null,
      status: "draft",
      seller_name: str(body.seller_name) ?? settings.seller_name,
      seller_gstin: str(body.seller_gstin) ?? settings.seller_gstin,
      seller_state_code: sellerState,
      seller_address: str(body.seller_address) ?? settings.seller_address,
      buyer_name: buyerName,
      buyer_gstin: str(body.buyer_gstin),
      buyer_address: str(body.buyer_address),
      place_of_supply: placeOfSupply,
      reverse_charge: body.reverse_charge === true,
      due_at: typeof body.due_at === "string" && body.due_at ? body.due_at : null,
      notes: str(body.notes),
      subtotal_paise: totals.subtotalPaise,
      cgst_paise: totals.cgstPaise,
      sgst_paise: totals.sgstPaise,
      igst_paise: totals.igstPaise,
      total_paise: totals.totalPaise,
      created_by: ctx.userId,
    })
    .select(INVOICE_COLUMNS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await replaceItems(admin, "invoice_items", "invoice_id", ctx.accountId, invoice.id, lines);
  } catch (err) {
    await admin.from("invoices").delete().eq("id", invoice.id).eq("account_id", ctx.accountId);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save items" }, { status: 500 });
  }

  return NextResponse.json({ invoice }, { status: 201 });
}
