// Update / delete a single lead source (admin+).
// PATCH accepts: name, is_active, regenerate_secret (issues a new
// HMAC secret, returned once — the old provider config stops working).

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { encrypt } from '@/lib/whatsapp/encryption';
import { generateSourceSecret } from '@/lib/lead-capture/hmac';

const SAFE_COLUMNS = 'id, account_id, type, name, is_active, created_at';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });

  const update: Record<string, unknown> = {};
  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name) return NextResponse.json({ error: 'name cannot be empty' }, { status: 400 });
    update.name = name;
  }
  if (typeof body.is_active === 'boolean') update.is_active = body.is_active;

  let newSecretPlain: string | null = null;
  if (body.regenerate_secret === true) {
    newSecretPlain = generateSourceSecret();
    update.secret = encrypt(newSecretPlain);
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { data, error } = await supabaseAdmin()
    .from('lead_sources')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select(SAFE_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    lead_source: data,
    // ONE-TIME ONLY — update the provider's webhook secret now.
    ...(newSecretPlain ? { secret: newSecretPlain } : {}),
  });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let ctx;
  try {
    ctx = await requireRole('admin');
  } catch (err) {
    return toErrorResponse(err);
  }

  const { error } = await supabaseAdmin()
    .from('lead_sources')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
