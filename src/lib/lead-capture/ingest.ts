// ============================================================
// Lead ingestion — the single write path for captured leads.
//
// Both the provider-webhook route and the Instagram comment engine
// funnel through `ingestLead`. Tenancy is explicit: every row is
// stamped with `accountId` (the service-role client bypasses RLS,
// so the app layer owns the scope — same discipline as the
// WhatsApp webhook handler).
//
// Dedup: a lead is "the same" when the account already has a lead
// with the same normalized phone (last-8-digit suffix, mirroring
// src/lib/contacts/dedupe.ts). A repeat capture updates the row's
// `updated_at` and logs `lead.recaptured` instead of inserting a
// duplicate.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { NormalizedLead } from './normalize';
import { normalizeReferralCode } from '@/lib/growth/referrals';

/** Last-8-digit suffix — matches the contacts dedup convention. */
export function phoneSuffix(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 8 ? digits.slice(-8) : null;
}

export interface IngestInput {
  accountId: string;
  leadSourceId: string | null;
  source: string;
  lead: NormalizedLead;
  rawPayload: unknown;
}

export interface IngestResult {
  leadId: string;
  /** True when an existing lead was re-captured instead of inserted. */
  wasRecapture: boolean;
}

async function logEvent(
  supabase: SupabaseClient,
  accountId: string,
  leadId: string | null,
  eventType: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await supabase.from('lead_events').insert({
    account_id: accountId,
    lead_id: leadId,
    event_type: eventType,
    details,
  });
  if (error) console.error('[lead-capture] lead_events insert failed:', error.message);
}

export async function ingestLead(
  supabase: SupabaseClient,
  input: IngestInput,
): Promise<IngestResult> {
  const { accountId, leadSourceId, source, lead, rawPayload } = input;
  const suffix = phoneSuffix(lead.phone);

  // Dedup by phone suffix within the account.
  if (suffix) {
    const { data: existing } = await supabase
      .from('leads')
      .select('id, status')
      .eq('account_id', accountId)
      .like('phone', `%${suffix}`)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      await supabase
        .from('leads')
        .update({
          name: lead.name ?? undefined,
          email: lead.email ?? undefined,
          campaign: lead.campaign ?? undefined,
        })
        .eq('id', existing.id);
      await logEvent(supabase, accountId, existing.id, 'lead.recaptured', {
        source,
        lead_source_id: leadSourceId,
      });
      return { leadId: existing.id, wasRecapture: true };
    }
  }

  const { data, error } = await supabase
    .from('leads')
    .insert({
      account_id: accountId,
      lead_source_id: leadSourceId,
      name: lead.name,
      phone: lead.phone,
      email: lead.email,
      source,
      campaign: lead.campaign,
      status: 'new',
      raw_payload: (rawPayload ?? {}) as Record<string, unknown>,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`lead insert failed: ${error?.message ?? 'unknown'}`);
  }

  await logEvent(supabase, accountId, data.id, 'lead.captured', {
    source,
    lead_source_id: leadSourceId,
    campaign: lead.campaign,
  });

  // Module 5 (growth): score the new lead. Best-effort.
  try {
    const { recomputeLeadScore } = await import('@/lib/growth/score-store');
    await recomputeLeadScore(supabase, accountId, data.id);
  } catch (err) {
    console.error('[growth] initial score failed:', err);
  }

  // Module 5 (growth): if the payload carried a referral code, record
  // the referral. Best-effort — never breaks ingestion.
  try {
    await recordReferralFromPayload(supabase, accountId, data.id, rawPayload);
  } catch (err) {
    console.error('[growth] referral record failed:', err);
  }

  return { leadId: data.id, wasRecapture: false };
}

/** Module 5: record a referral when the capture payload carries a
 *  referral code (case-insensitive `referral_code` key). Looks the
 *  code up in this account; unknown codes are ignored silently. */
async function recordReferralFromPayload(
  supabase: SupabaseClient,
  accountId: string,
  leadId: string,
  rawPayload: unknown,
): Promise<void> {
  if (!rawPayload || typeof rawPayload !== 'object') return;
  const payload = rawPayload as Record<string, unknown>;
  let rawCode: unknown = null;
  for (const k of Object.keys(payload)) {
    if (k.toLowerCase() === 'referral_code') {
      rawCode = payload[k];
      break;
    }
  }
  const code = normalizeReferralCode(typeof rawCode === 'string' ? rawCode : null);
  if (!code) return;

  const { data: codeRow } = await supabase
    .from('referral_codes')
    .select('contact_id')
    .eq('account_id', accountId)
    .eq('code', code)
    .maybeSingle();
  if (!codeRow) return;

  await supabase.from('referrals').insert({
    account_id: accountId,
    referrer_contact_id: (codeRow as { contact_id: string }).contact_id,
    referee_lead_id: leadId,
    code,
  });
}

export async function logLeadEvent(  supabase: SupabaseClient,
  accountId: string,
  leadId: string | null,
  eventType: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await logEvent(supabase, accountId, leadId, eventType, details);
}
