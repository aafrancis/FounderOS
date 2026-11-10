import { NextResponse } from 'next/server';
import { ARM_THROTTLE_KEY, getApprovals, refusalResponse } from '@/lib/approvals-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Who holds a proposing token: names, channels, dates. Never a token or a hash. */
export async function GET() {
  return NextResponse.json({ tokens: getApprovals().tokens() });
}

/**
 *   { action: "issue", name, channels: [..], armSecret }   shows the token ONCE
 *   { action: "revoke", name }                             needs no secret: it only removes a right
 * Operator session only (not a token path). Issuing needs the arming secret
 * because a token is a right to file proposals.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'JSON body required', code: 'invalid' }, { status: 400 });
  const approvals = getApprovals();
  if (body.action === 'revoke') {
    const r = approvals.revokeToken(String(body.name ?? ''), 'operator');
    return r.ok ? NextResponse.json(r) : refusalResponse(r);
  }
  if (body.action === 'issue') {
    const { armSecret, action: _a, ...input } = body;
    void _a;
    const r = approvals.issueToken(input, armSecret, 'operator', ARM_THROTTLE_KEY);
    return r.ok ? NextResponse.json(r, { headers: { 'cache-control': 'no-store' } }) : refusalResponse(r);
  }
  return NextResponse.json({ error: 'action must be "issue" or "revoke"', code: 'invalid' }, { status: 400 });
}
