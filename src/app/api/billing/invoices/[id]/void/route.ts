// POST /api/billing/invoices/[id]/void — cancel an issued invoice
// (admin+). Allowed only when no payments have been recorded — a
// partially paid invoice must be resolved through payments/refunds,
// not by voiding, so the money trail never contradicts the status.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

export async function POST(
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
  const { data: invoice, error: fetchError } = await admin
    .from("invoices")
    .select("id, status, amount_paid_paise")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (fetchError || !invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (!["issued", "partially_paid", "overdue"].includes(invoice.status as string)) {
    return NextResponse.json(
      { error: `Only issued invoices can be voided (status: ${invoice.status})` },
      { status: 409 },
    );
  }
  if ((invoice.amount_paid_paise as number) > 0) {
    return NextResponse.json(
      { error: "Cannot void an invoice with recorded payments — resolve the payments first" },
      { status: 409 },
    );
  }

  const { data, error } = await admin
    .from("invoices")
    .update({ status: "cancelled" })
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .select("id, number, status")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ invoice: data });
}
