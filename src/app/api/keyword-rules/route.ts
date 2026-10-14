// Keyword rules — Instagram comment-to-DM triggers (admin+).
// GET lists active+inactive rules; POST creates one. Keywords are
// matched case-insensitively as substrings of the comment text.

import { NextResponse } from 'next/server';
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';

export async function GET() {
  try {
    const { supabase } = await getCurrentAccount();
    const { data, error } = await supabase
      .from('keyword_rules')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ keyword_rules: data ?? [] });
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

  const keyword = typeof body.keyword === 'string' ? body.keyword.trim() : '';
  if (!keyword) return NextResponse.json({ error: 'keyword is required' }, { status: 400 });
  if (keyword.length > 60) {
    return NextResponse.json({ error: 'keyword must be 60 characters or fewer' }, { status: 400 });
  }
  const reply_template =
    typeof body.reply_template === 'string' && body.reply_template.trim()
      ? body.reply_template
      : 'Hi {{name}}! Thanks for your interest — we will DM you the details shortly.';

  const { data, error } = await supabaseAdmin()
    .from('keyword_rules')
    .insert({
      account_id: ctx.accountId,
      created_by: ctx.userId,
      keyword,
      reply_template,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    // 23505 = unique violation (account_id, keyword) — the rule exists.
    if ((error as { code?: string }).code === '23505') {
      return NextResponse.json(
        { error: 'A rule for this keyword already exists' },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ keyword_rule: data }, { status: 201 });
}
