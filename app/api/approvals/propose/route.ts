import { NextResponse } from 'next/server';
import { bearerOf } from '@/lib/approval-tokens';
import { getApprovals, respondFiled } from '@/lib/approvals-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * How an agent files a proposal: `Authorization: Bearer apt_...`, body as for
 * POST /api/approvals. This path is open to the middleware (lib/auth-gate.ts
 * TOKEN_PATHS), so THIS route is the gate and it fails closed: no valid token,
 * 401, and nothing is read from the body or written to the database first.
 * The proposer's name and channels come from the token, never from the body.
 */
export async function POST(req: Request) {
  const approvals = getApprovals();
  const agent = approvals.authenticateToken(bearerOf(req));
  if (!agent) {
    return NextResponse.json({ error: 'A valid agent token is required (Authorization: Bearer <token>).', code: 'bad_token' }, { status: 401 });
  }
  const body = await req.json().catch(() => null);
  return respondFiled(approvals, approvals.proposeAs(agent, body));
}
