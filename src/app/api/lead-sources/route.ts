// Lead sources — connected inbound lead providers.
// GET lists (RLS-scoped; secrets are NEVER returned).
// POST creates (admin+). The plaintext HMAC secret (and, for
// instagram, the hub verify_token) are returned exactly once —
// store them in the provider's dashboard, they can't be read back.

import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import { generateSourceSecret } from '@/lib/lead-capture/hmac';
import { randomBytes } from 'node:crypto';

const SOURCE_TYPES = ['facebook_lead_ads', 'justdial', 'web_form', 'instagram'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

const SAFE_COLUMNS = 'id, account_id, type, name, is_active, created_at';

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('lead_sources')
      .select(SAFE_COLUMNS)
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ lead_sources: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const type = body.type as SourceType;
  if (!SOURCE_TYPES.includes(type)) {
    return NextResponse.json(
      { error: `type must be one of: ${SOURCE_TYPES.join(', ')}` },
      { status: 400 },
    );
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  // Per-source HMAC secret — shown once, stored encrypted.
  const secretPlain = generateSourceSecret();
  const insert: Record<string, unknown> = {
    account_id: ctx.accountId,
    created_by: ctx.userId,
    type,
    name,
    secret: encrypt(secretPlain),
    is_active: true,
  };

  // Instagram sources also need a hub.verify_token for Meta's
  // subscription handshake — also shown once, stored encrypted.
  let verifyTokenPlain: string | null = null;
  if (type === 'instagram') {
    verifyTokenPlain = randomBytes(24).toString('hex');
    insert.verify_token = encrypt(verifyTokenPlain);
  }

  const { data, error } = await supabaseAdmin()
    .from('lead_sources')
    .insert(insert)
    .select(SAFE_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(
    {
      lead_source: data,
      // ONE-TIME ONLY — configure the provider / Meta dashboard now.
      secret: secretPlain,
      ...(verifyTokenPlain ? { verify_token: verifyTokenPlain } : {}),
    },
    { status: 201 },
  );
}
