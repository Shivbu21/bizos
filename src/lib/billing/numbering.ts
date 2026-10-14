// Race-safe per-account document numbering.
//
// Numbers come from the `next_billing_number(account, kind)` RPC
// (migration 040): it locks the account's billing_settings row,
// increments exactly one counter, and returns PREFIX-YYYY-NNNN
// (e.g. INV-2026-0001). Counters only move forward — a number is
// never reused, even if the document is later deleted.

import { supabaseAdmin } from "@/lib/automations/admin-client";

export type BillingNumberKind = "quote" | "invoice" | "receipt";

/** Allocate the next number for an account. Never returns a duplicate:
 *  the RPC serializes concurrent callers on the settings row lock. */
export async function nextBillingNumber(
  accountId: string,
  kind: BillingNumberKind,
): Promise<string> {
  const { data, error } = await supabaseAdmin().rpc("next_billing_number", {
    p_account_id: accountId,
    p_kind: kind,
  });
  if (error) {
    throw new Error(`Failed to allocate ${kind} number: ${error.message}`);
  }
  if (typeof data !== "string" || !data) {
    throw new Error(`Failed to allocate ${kind} number: empty response`);
  }
  return data;
}

/** Pure format helper (mirrors the SQL) — used by tests and previews. */
export function formatBillingNumber(prefix: string, year: number, seq: number): string {
  return `${prefix}-${year}-${String(seq).padStart(4, "0")}`;
}
