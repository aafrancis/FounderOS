import { NextResponse } from 'next/server';
import { getApprovals, refusalResponse } from '@/lib/approvals-server';

// One lockout for the whole instance. It must not key on x-forwarded-for: the client sets that
// header, so a caller could rotate it per request and never hit the limit (found in review).
const ARM_THROTTLE_KEY = 'arm:global';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Arm or disarm a channel.
 *   { action: "arm", channel, mode, dailyCapCount, dailyCapCents, armSecret }
 *   { action: "disarm", channel }
 * Arming needs the arming secret, which is not the login password. Disarming
 * needs nothing: it only ever removes rights.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'JSON body required', code: 'invalid' }, { status: 400 });
  const approvals = getApprovals();
  if (body.action === 'disarm') {
    const r = approvals.disarm(String(body.channel ?? ''), 'operator');
    return r.ok ? NextResponse.json(r) : refusalResponse(r);
  }
  if (body.action === 'arm') {
    const { armSecret, action: _a, ...grant } = body;
    void _a;
    const r = approvals.arm(grant, armSecret, 'operator', ARM_THROTTLE_KEY);
    return r.ok ? NextResponse.json(r) : refusalResponse(r);
  }
  return NextResponse.json({ error: 'action must be "arm" or "disarm"', code: 'invalid' }, { status: 400 });
}
