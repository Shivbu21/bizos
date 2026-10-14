// ============================================================
// POST /api/lead-capture/webhook?source=<lead_source_id>
//
// Generic HMAC-verified inbound lead webhook. The provider (Facebook
// Lead Ads, Justdial, website contact form) POSTs its native payload;
// we verify `X-Signature` against the source's stored secret, then
// normalize into the shared lead stream.
//
// URL to paste into the provider's dashboard:
//   https://<your-host>/api/lead-capture/webhook?source=<id>
// The <id> is shown on the Lead Sources page after creation.
//
// Security: the source id is not a capability — the HMAC check is.
// An unknown/inactive source or a bad signature is rejected loudly
// (401) so provider dashboards surface misconfigurations.
// ============================================================

import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyInboundHmac } from '@/lib/lead-capture/hmac';
import { normalizeLeadPayload, type LeadSourceType } from '@/lib/lead-capture/normalize';
import { ingestLead } from '@/lib/lead-capture/ingest';

export const maxDuration = 60;

const PROVIDER_TYPES: LeadSourceType[] = ['facebook_lead_ads', 'justdial', 'web_form'];

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const sourceId = searchParams.get('source');
  if (!sourceId) {
    return NextResponse.json(
      { error: 'Missing ?source=<lead_source_id> query parameter' },
      { status: 400 },
    );
  }

  const admin = supabaseAdmin();
  const { data: source, error: sourceError } = await admin
    .from('lead_sources')
    .select('id, account_id, type, name, secret, is_active')
    .eq('id', sourceId)
    .maybeSingle();

  if (sourceError || !source || !source.is_active) {
    return NextResponse.json({ error: 'Unknown or inactive lead source' }, { status: 404 });
  }
  if (!PROVIDER_TYPES.includes(source.type as LeadSourceType)) {
    return NextResponse.json(
      { error: `Source type '${source.type}' does not accept provider webhooks` },
      { status: 400 },
    );
  }

  // Read raw bytes first — request.json() would re-encode and break HMAC.
  const rawBody = await request.text();
  let secret: string;
  try {
    secret = decrypt(source.secret);
  } catch {
    console.error('[lead-capture] failed to decrypt secret for source', source.id);
    return NextResponse.json({ error: 'Source misconfigured' }, { status: 500 });
  }

  const signature = request.headers.get('x-signature');
  if (!verifyInboundHmac(signature, rawBody, secret)) {
    console.warn('[lead-capture] rejected webhook with invalid signature for source', source.id);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  let normalized;
  try {
    normalized = normalizeLeadPayload(source.type as LeadSourceType, body);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Normalization failed' },
      { status: 400 },
    );
  }

  // Ingest after ack so the provider never waits on our DB writes.
  // (Same after() discipline as the WhatsApp webhook: a detached
  // promise can be frozen on serverless before its writes land.)
  const payload = { sourceId: source.id, accountId: source.account_id, type: source.type, normalized, body };
  after(async () => {
    try {
      await ingestLead(admin, {
        accountId: payload.accountId,
        leadSourceId: payload.sourceId,
        source: payload.type,
        lead: payload.normalized,
        rawPayload: payload.body,
      });
    } catch (err) {
      console.error('[lead-capture] ingest failed:', err);
    }
  });

  return NextResponse.json({ status: 'received' }, { status: 200 });
}
