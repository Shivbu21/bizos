// POST /api/billing/quotes/[id]/convert — accepted quote → draft
// invoice (agent+).
//
// The quote's line economics carry over; GST is recomputed against
// the invoice's seller/place-of-supply states so the per-line
// CGST/SGST/IGST snapshot is correct at conversion time. The quote
// stays `accepted` (quotes are never mutated by conversion — the
// new invoice links back via quote_id).

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  allocateNumber,
  getBillingSettings,
  priceLines,
  quoteLinesToInvoiceInput,
  replaceItems,
} from "@/lib/billing/server";

export async function POST(
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
  const { data: quote, error: quoteError } = await admin
    .from("quotes")
    .select(
      "id, account_id, number, lead_id, customer_name, customer_email, customer_phone, customer_address, status",
    )
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (quoteError || !quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  if (quote.status !== "accepted") {
    return NextResponse.json({ error: "Only accepted quotes can be converted to invoices" }, { status: 409 });
  }

  const { data: items, error: itemsError } = await admin
    .from("quote_items")
    .select("description, quantity, rate_paise, gst_rate")
    .eq("quote_id", id)
    .order("position");
  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });
  if (!items || items.length === 0) {
    return NextResponse.json({ error: "Quote has no items to convert" }, { status: 409 });
  }

  const body = await request.json().catch(() => ({}));
  let settings;
  try {
    settings = await getBillingSettings(admin, ctx.accountId);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Settings failed" }, { status: 500 });
  }

  const sellerState = typeof body.seller_state_code === "string" && body.seller_state_code
    ? body.seller_state_code
    : settings.seller_state_code;
  const placeOfSupply = typeof body.place_of_supply === "string" && body.place_of_supply
    ? body.place_of_supply
    : sellerState; // same state → intra-state when unspecified

  const parsed = quoteLinesToInvoiceInput(items);
  const { lines, totals } = priceLines(parsed, sellerState, placeOfSupply);

  let number: string;
  try {
    number = await allocateNumber(ctx.accountId, "invoice");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Numbering failed" }, { status: 500 });
  }

  const { data: invoice, error: invError } = await admin
    .from("invoices")
    .insert({
      account_id: ctx.accountId,
      number,
      quote_id: quote.id,
      lead_id: quote.lead_id,
      status: "draft",
      seller_name: settings.seller_name,
      seller_gstin: settings.seller_gstin,
      seller_state_code: sellerState,
      seller_address: settings.seller_address,
      buyer_name: quote.customer_name,
      buyer_address: quote.customer_address,
      place_of_supply: placeOfSupply,
      subtotal_paise: totals.subtotalPaise,
      cgst_paise: totals.cgstPaise,
      sgst_paise: totals.sgstPaise,
      igst_paise: totals.igstPaise,
      total_paise: totals.totalPaise,
      created_by: ctx.userId,
    })
    .select("id, number, status, total_paise")
    .single();
  if (invError) return NextResponse.json({ error: invError.message }, { status: 500 });

  try {
    await replaceItems(admin, "invoice_items", "invoice_id", ctx.accountId, invoice.id, lines);
  } catch (err) {
    await admin.from("invoices").delete().eq("id", invoice.id).eq("account_id", ctx.accountId);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save items" }, { status: 500 });
  }

  return NextResponse.json({ invoice }, { status: 201 });
}
