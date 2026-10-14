// Quotes — list and create (agent+).
// GET lists the account's quotes (RLS-scoped). POST creates a draft
// quote with a race-safe sequential number; totals are computed
// server-side from the items, never trusted from the client.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import {
  allocateNumber,
  getBillingSettings,
  parseLineItems,
  priceLines,
  replaceItems,
} from "@/lib/billing/server";

const QUOTE_COLUMNS =
  "id, account_id, number, lead_id, customer_name, customer_email, customer_phone, customer_address, status, valid_until, notes, currency, subtotal_paise, tax_paise, total_paise, created_at, updated_at";

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status");
    let query = supabase.from("quotes").select(QUOTE_COLUMNS).order("created_at", { ascending: false }).limit(200);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ quotes: data ?? [] });
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

  const customerName = typeof body.customer_name === "string" ? body.customer_name.trim() : "";
  if (!customerName) return NextResponse.json({ error: "customer_name is required" }, { status: 400 });

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

  // Quotes carry totals only (no per-line state split yet — that is
  // snapshotted at invoice time). Intra-state default is fine here.
  const { lines, totals } = priceLines(items, null, null);

  let number: string;
  try {
    number = await allocateNumber(ctx.accountId, "quote");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Numbering failed" }, { status: 500 });
  }

  const insert: Record<string, unknown> = {
    account_id: ctx.accountId,
    number,
    lead_id: typeof body.lead_id === "string" && body.lead_id ? body.lead_id : null,
    customer_name: customerName,
    customer_email: typeof body.customer_email === "string" ? body.customer_email.trim() || null : null,
    customer_phone: typeof body.customer_phone === "string" ? body.customer_phone.trim() || null : null,
    customer_address: typeof body.customer_address === "string" ? body.customer_address.trim() || null : null,
    valid_until: typeof body.valid_until === "string" && body.valid_until ? body.valid_until : null,
    notes: typeof body.notes === "string" ? body.notes.trim() || null : null,
    subtotal_paise: totals.subtotalPaise,
    tax_paise: totals.taxPaise,
    total_paise: totals.totalPaise,
    created_by: ctx.userId,
  };

  const { data: quote, error } = await admin.from("quotes").insert(insert).select(QUOTE_COLUMNS).single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  try {
    await replaceItems(admin, "quote_items", "quote_id", ctx.accountId, quote.id, lines);
  } catch (err) {
    // Roll back the header if the items failed — never leave a
    // number-bearing quote with no lines.
    await admin.from("quotes").delete().eq("id", quote.id).eq("account_id", ctx.accountId);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save items" }, { status: 500 });
  }

  return NextResponse.json({ quote, number }, { status: 201 });
}
