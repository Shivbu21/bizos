// Captured leads — read-only list for the dashboard.
// Any account member may read (RLS scopes by account).
// Query params: limit (default 50, max 200), status (optional filter).

import { NextResponse } from 'next/server';
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';

const STATUSES = ['new', 'contacted', 'qualified', 'converted', 'lost'];

export async function GET(request: Request) {
  try {
    const { supabase } = await getCurrentAccount();
    const { searchParams } = new URL(request.url);

    const limit = Math.min(
      Math.max(parseInt(searchParams.get('limit') ?? '50', 10) || 50, 1),
      200,
    );
    const status = searchParams.get('status');

    let query = supabase
      .from('leads')
      .select(
        'id, name, phone, email, source, campaign, status, created_at, lead_sources(name)',
      )
      .order('created_at', { ascending: false })
      .limit(limit);

    if (status) {
      if (!STATUSES.includes(status)) {
        return NextResponse.json(
          { error: `status must be one of: ${STATUSES.join(', ')}` },
          { status: 400 },
        );
      }
      query = query.eq('status', status);
    }

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ leads: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}
