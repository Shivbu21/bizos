// Shared quote status-transition logic for the action routes.
// Each route (send / accept / decline) calls transitionQuote with
// its action; preconditions are enforced here in one place.

import { NextResponse } from "next/server";
import { requireRole, toErrorResponse } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/automations/admin-client";

export type QuoteAction = "send" | "accept" | "decline";

const TRANSITIONS: Record<QuoteAction, { from: string[]; to: string }> = {
  send: { from: ["draft"], to: "sent" },
  accept: { from: ["sent"], to: "accepted" },
  decline: { from: ["sent"], to: "declined" },
};

export async function transitionQuote(
  request: Request,
  params: Promise<{ id: string }>,
  action: QuoteAction,
) {
  const { id } = await params;
  const t = TRANSITIONS[action];
  let ctx;
  try {
    ctx = await requireRole("agent");
  } catch (err) {
    return toErrorResponse(err);
  }

  const admin = supabaseAdmin();
  const { data: quote, error: fetchError } = await admin
    .from("quotes")
    .select("id, status")
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .single();
  if (fetchError || !quote) return NextResponse.json({ error: "Quote not found" }, { status: 404 });
  if (!t.from.includes(quote.status as string)) {
    return NextResponse.json(
      { error: `Cannot ${action} a quote with status '${quote.status}'` },
      { status: 409 },
    );
  }

  if (action === "send") {
    const { count } = await admin
      .from("quote_items")
      .select("id", { count: "exact", head: true })
      .eq("quote_id", id);
    if (!count) {
      return NextResponse.json({ error: "Cannot send a quote with no items" }, { status: 409 });
    }
  }

  const { data, error } = await admin
    .from("quotes")
    .update({ status: t.to })
    .eq("id", id)
    .eq("account_id", ctx.accountId)
    .select("id, number, status")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ quote: data });
}
