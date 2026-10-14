// Single quote: read (any member), edit draft (agent+), delete draft
// (admin+). Edits are full rewrites of the item set; totals are
// recomputed server-side.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { parseLineItems, priceLines, replaceItems } from "@/lib/billing/server";

const QUOTE_COLUMNS =
  "id, account_id, number, lead_id, customer_name, customer_email, customer_phone, customer_address, status, valid_until, notes, currency, subtotal_paise, tax_paise, total_paise, created_at, updated_at";
const ITEM_COLUMNS =
  "id, description, quantity, rate_paise, gst_rate, line_taxable_paise, line_tax_paise, line_total_paise, position";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data: quote, error } = await supabase.from("quotes").select(QUOTE_COLUMNS).eq("id", id).single();
    if (error || !quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });
    const { data: items } = await supabase
      .from("quote_items")
      .select(ITEM_COLUMNS)
      .eq("quote_id", id)
      .order("position");
    return NextResponse.json({ quote, items: items ?? [] });
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
    .from("quotes")
    .select("id, status")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (fetchError || !existing) return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  if (existing.status !== "draft") {
    return NextResponse.json({ error: "Only draft quotes can be edited" }, { status: 409 });
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const update: Record<string, unknown> = {};
  for (const key of ["customer_name", "customer_email", "customer_phone", "customer_address", "notes"] as const) {
    if (typeof body[key] === "string") {
      const v = body[key].trim();
      if (key === "customer_name" && !v) return NextResponse.json({ error: "customer_name cannot be empty" }, { status: 400 });
      update[key] = v || null;
    }
  }
  if (typeof body.valid_until === "string") update.valid_until = body.valid_until || null;

  if (body.items !== undefined) {
    let items;
    try {
      items = parseLineItems(body.items);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid items" }, { status: 400 });
    }
    const { lines, totals } = priceLines(items, null, null);
    update.subtotal_paise = totals.subtotalPaise;
    update.tax_paise = totals.taxPaise;
    update.total_paise = totals.totalPaise;
    try {
      await replaceItems(admin, "quote_items", "quote_id", ctx.accountId, id, lines);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save items" }, { status: 500 });
    }
  }

  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true });

  const { data, error } = await admin
    .from("quotes")
    .update(update)
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .select(QUOTE_COLUMNS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ quote: data });
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
    .from("quotes")
    .select("id, status")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (!existing) return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  if (existing.status !== "draft") {
    return NextResponse.json({ error: "Only draft quotes can be deleted" }, { status: 409 });
  }

  const { error } = await admin.from("quotes").delete().eq("id", id).eq("account_id", ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
