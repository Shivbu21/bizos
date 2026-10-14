// Update / delete a single keyword rule (admin+).
// PATCH accepts: keyword, reply_template, is_active.

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

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
  if (typeof body.keyword === 'string') {
    const keyword = body.keyword.trim();
    if (!keyword) return NextResponse.json({ error: 'keyword cannot be empty' }, { status: 400 });
    if (keyword.length > 60) {
      return NextResponse.json({ error: 'keyword must be 60 characters or fewer' }, { status: 400 });
    }
    update.keyword = keyword;
  }
  if (typeof body.reply_template === 'string') {
    if (!body.reply_template.trim()) {
      return NextResponse.json({ error: 'reply_template cannot be empty' }, { status: 400 });
    }
    update.reply_template = body.reply_template;
  }
  if (typeof body.is_active === 'boolean') update.is_active = body.is_active;

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: true });
  }

  const { data, error } = await supabaseAdmin()
    .from('keyword_rules')
    .update(update)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .select()
    .single();

  if (error) {
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'A rule for this keyword already exists' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ keyword_rule: data });
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
    .from('keyword_rules')
    .delete()
    .eq('id', id)
    .eq('account_id', ctx.accountId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
