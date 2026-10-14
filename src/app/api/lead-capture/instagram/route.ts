// ============================================================
// /api/lead-capture/instagram?source=<lead_source_id>
//
// Instagram comment-to-DM trigger endpoint.
//
// GET  — Meta's hub verification handshake. hub.verify_token is
//        matched against the instagram source's stored verify_token.
// POST — Meta delivers comment events. Verified with META_APP_SECRET
//        (x-hub-signature-256), then each comment runs through the
//        account's keyword rules: match → create/find lead → queue DM.
//
// Subscribe this URL in the Meta App Dashboard (Webhooks → instagram)
// with ?source=<id> appended — the query param is how one app-level
// subscription fans out to the right account.
//
// DM delivery is a stub until META_IG_PAGE_ACCESS_TOKEN /
// META_IG_PAGE_ID are configured — see
// src/lib/lead-capture/instagram.ts.
// ============================================================

import { NextResponse, after } from 'next/server';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { decrypt } from '@/lib/whatsapp/encryption';
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature';
import {
  extractComments,
  handleInstagramComment,
  type KeywordRule,
} from '@/lib/lead-capture/instagram';

export const maxDuration = 60;

async function loadInstagramSource(sourceId: string) {
  const { data, error } = await supabaseAdmin()
    .from('lead_sources')
    .select('id, account_id, type, verify_token, is_active')
    .eq('id', sourceId)
    .eq('type', 'instagram')
    .maybeSingle();
  if (error || !data || !data.is_active) return null;
  return data;
}

// GET - Meta hub verification
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const challenge = searchParams.get('hub.challenge');
  const verifyToken = searchParams.get('hub.verify_token');
  const sourceId = searchParams.get('source');

  if (mode !== 'subscribe' || !challenge || !verifyToken || !sourceId) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 });
  }

  const source = await loadInstagramSource(sourceId);
  if (!source?.verify_token) {
    return NextResponse.json({ error: 'Unknown lead source' }, { status: 404 });
  }

  let stored: string;
  try {
    stored = decrypt(source.verify_token);
  } catch {
    console.error('[lead-capture] failed to decrypt verify_token for source', source.id);
    return NextResponse.json({ error: 'Source misconfigured' }, { status: 500 });
  }

  if (stored !== verifyToken) {
    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 });
  }

  return new Response(challenge, {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
}

// POST - comment events
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const sourceId = searchParams.get('source');
  if (!sourceId) {
    return NextResponse.json({ error: 'Missing ?source=<lead_source_id>' }, { status: 400 });
  }

  const source = await loadInstagramSource(sourceId);
  if (!source) {
    return NextResponse.json({ error: 'Unknown or inactive lead source' }, { status: 404 });
  }

  const rawBody = await request.text();
  if (!verifyMetaWebhookSignature(rawBody, request.headers.get('x-hub-signature-256'))) {
    console.warn('[lead-capture] rejected IG webhook with invalid Meta signature');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const comments = extractComments(body as Record<string, unknown>);
  if (comments.length === 0) {
    return NextResponse.json({ status: 'received', comments: 0 }, { status: 200 });
  }

  const admin = supabaseAdmin();
  const { data: rules } = await admin
    .from('keyword_rules')
    .select('id, keyword, reply_template')
    .eq('account_id', source.account_id)
    .eq('is_active', true);
  const activeRules: KeywordRule[] = (rules ?? []) as KeywordRule[];

  const accountId = source.account_id;
  after(async () => {
    for (const comment of comments) {
      try {
        await handleInstagramComment(admin, accountId, sourceId, comment, activeRules);
      } catch (err) {
        console.error('[lead-capture] IG comment handling failed:', err);
      }
    }
  });

  return NextResponse.json(
    { status: 'received', comments: comments.length },
    { status: 200 },
  );
}
