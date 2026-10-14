// POST /api/billing/invoices/[id]/issue — draft → issued (agent+).
//
// Issuing snapshots the invoice: totals are recomputed from the
// items one final time (server-side, never the client's), issued_at
// is stamped, and a due date defaults to 15 days out when none was
// set. An issued invoice's items can no longer be edited.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { parseLineItems, priceLines, replaceItems } from "@/lib/billing/server";

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
  const { data: invoice, error: fetchError } = await admin
    .from("invoices")
    .select("id, status, seller_state_code, place_of_supply, due_at")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (fetchError || !invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (invoice.status !== "draft") {
    return NextResponse.json({ error: `Only draft invoices can be issued (status: ${invoice.status})` }, { status: 409 });
  }

  const { data: items, error: itemsError } = await admin
    .from("invoice_items")
    .select("description, quantity, rate_paise, gst_rate")
    .eq("invoice_id", id)
    .order("position");
  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });
  if (!items || items.length === 0) {
    return NextResponse.json({ error: "Cannot issue an invoice with no items" }, { status: 409 });
  }

  // Final server-side snapshot of the GST math.
  const parsed = items.map((i) => ({
    description: i.description as string,
    quantity: Number(i.quantity),
    ratePaise: i.rate_paise as number,
    gstRate: Number(i.gst_rate),
  }));
  let priced;
  try {
    priced = priceLines(parsed, invoice.seller_state_code as string | null, invoice.place_of_supply as string | null);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid items" }, { status: 400 });
  }
  try {
    await replaceItems(admin, "invoice_items", "invoice_id", ctx.accountId, id, priced.lines);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to snapshot items" }, { status: 500 });
  }

  const body = await request.json().catch(() => ({}));
  let dueAt = invoice.due_at as string | null;
  if (typeof body.due_at === "string" && body.due_at) {
    dueAt = body.due_at;
  } else if (!dueAt) {
    const d = new Date();
    d.setDate(d.getDate() + 15);
    dueAt = d.toISOString().slice(0, 10);
  }

  const { data, error } = await admin
    .from("invoices")
    .update({
      status: "issued",
      issued_at: new Date().toISOString(),
      due_at: dueAt,
      subtotal_paise: priced.totals.subtotalPaise,
      cgst_paise: priced.totals.cgstPaise,
      sgst_paise: priced.totals.sgstPaise,
      igst_paise: priced.totals.igstPaise,
      total_paise: priced.totals.totalPaise,
    })
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .select("id, number, status, total_paise, issued_at, due_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ invoice: data });
}
