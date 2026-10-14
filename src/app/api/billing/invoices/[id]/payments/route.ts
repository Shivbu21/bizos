// Payments against an invoice (agent+).
// GET lists the invoice's payments. POST records one: it allocates
// a race-safe receipt number, inserts the immutable payment row,
// and recomputes the invoice's amount_paid + status
// (issued → partially_paid → paid). Overpayments are rejected —
// the receipt must never exceed the amount due.

import { NextResponse } from "next/server";
import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";
import { allocateNumber, refreshInvoicePaymentState } from "@/lib/billing/server";

const PAYMENT_METHODS = ["cash", "upi", "bank_transfer", "card", "other"] as const;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from("payments")
      .select("id, receipt_number, amount_paise, method, reference, received_at, created_at")
      .eq("invoice_id", id)
      .order("received_at", { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ payments: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

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

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const amountPaise = Number(body.amount_paise ?? body.amountPaise);
  if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
    return NextResponse.json({ error: "amount_paise must be a positive integer (paise)" }, { status: 400 });
  }
  const method = body.method as string;
  if (!PAYMENT_METHODS.includes(method as (typeof PAYMENT_METHODS)[number])) {
    return NextResponse.json({ error: `method must be one of: ${PAYMENT_METHODS.join(", ")}` }, { status: 400 });
  }
  const receivedAt =
    typeof body.received_at === "string" && body.received_at ? body.received_at : new Date().toISOString().slice(0, 10);

  const admin = supabaseAdmin();
  const { data: invoice, error: invError } = await admin
    .from("invoices")
    .select("id, number, status, total_paise, amount_paid_paise")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (invError || !invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  if (!["issued", "partially_paid", "overdue"].includes(invoice.status as string)) {
    return NextResponse.json(
      { error: `Cannot record a payment on a ${invoice.status} invoice` },
      { status: 409 },
    );
  }

  const due = (invoice.total_paise as number) - (invoice.amount_paid_paise as number);
  if (amountPaise > due) {
    return NextResponse.json(
      { error: `Payment exceeds the amount due (${due} paise). Record ${due} paise or less.` },
      { status: 400 },
    );
  }

  let receiptNumber: string;
  try {
    receiptNumber = await allocateNumber(ctx.accountId, "receipt");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Numbering failed" }, { status: 500 });
  }

  const { data: payment, error: payError } = await admin
    .from("payments")
    .insert({
      account_id: ctx.accountId,
      invoice_id: id,
      receipt_number: receiptNumber,
      amount_paise: amountPaise,
      method,
      reference: typeof body.reference === "string" && body.reference.trim() ? body.reference.trim() : null,
      received_at: receivedAt,
      created_by: ctx.userId,
    })
    .select("id, receipt_number, amount_paise, method, reference, received_at, created_at")
    .single();
  if (payError) return NextResponse.json({ error: payError.message }, { status: 500 });

  let state;
  try {
    state = await refreshInvoicePaymentState(admin, ctx.accountId, id);
  } catch (err) {
    // The payment is recorded; surfacing the refresh failure lets the
    // caller retry the state recompute without double-recording.
    return NextResponse.json(
      { payment, warning: err instanceof Error ? err.message : "Failed to refresh invoice status" },
      { status: 201 },
    );
  }

  // Module 5 (growth): invoice just flipped to paid → queue a
  // post-invoice review request. Best-effort: never breaks the
  // payment response.
  if (state.status === "paid") {
    try {
      const { queueReviewRequest } = await import("@/lib/growth/reviews");
      await queueReviewRequest(admin, { accountId: ctx.accountId, invoiceId: id });
    } catch (err) {
      console.error("[growth] review queue failed:", err);
    }
  }

  return NextResponse.json({ payment, invoice_status: state.status, amount_paid_paise: state.amount_paid_paise }, { status: 201 });
}
