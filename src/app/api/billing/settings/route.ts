// Billing settings — the account's seller profile + numbering
// prefixes (admin+). Read by any member; invoices prefill their
// seller snapshot from here at creation.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { getBillingSettings } from "@/lib/billing/server";

const SETTINGS_COLUMNS =
  "account_id, seller_name, seller_gstin, seller_state_code, seller_address, quote_prefix, invoice_prefix, receipt_prefix";

export async function GET() {
  try {
    const { accountId } = await getCurrentAccount();
    const settings = await getBillingSettings(supabaseAdmin(), accountId);
    const { account_id, ...rest } = settings;
    void account_id;
    return NextResponse.json({ billing_settings: rest });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  let ctx;
  try {
    ctx = await requireRole("admin");
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const update: Record<string, unknown> = {};
  for (const key of [
    "seller_name", "seller_gstin", "seller_state_code", "seller_address",
    "quote_prefix", "invoice_prefix", "receipt_prefix",
  ] as const) {
    if (body[key] !== undefined) {
      if (typeof body[key] !== "string") {
        return NextResponse.json({ error: `${key} must be a string` }, { status: 400 });
      }
      const v = body[key].trim();
      if (key.endsWith("_prefix") && !v) {
        return NextResponse.json({ error: `${key} cannot be empty` }, { status: 400 });
      }
      if (key === "seller_state_code" && v && !/^\d{2}$/.test(v)) {
        return NextResponse.json({ error: "seller_state_code must be a 2-digit GST state code" }, { status: 400 });
      }
      update[key] = v || null;
      if (key.endsWith("_prefix")) update[key] = v.toUpperCase();
    }
  }
  if (Object.keys(update).length === 0) return NextResponse.json({ ok: true });

  const admin = supabaseAdmin();
  // Ensure the row exists (counters start at 0), then update.
  await getBillingSettings(admin, ctx.accountId);
  const { data, error } = await admin
    .from("billing_settings")
    .update(update)
    .eq("account_id", ctx.accountId)
    .select(SETTINGS_COLUMNS)
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ billing_settings: data });
}
