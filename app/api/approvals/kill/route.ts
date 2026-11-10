import { NextResponse } from 'next/server';
import { getApprovals, refusalResponse } from '@/lib/approvals-server';

// One lockout for the whole instance. It must not key on x-forwarded-for: the client sets that
// header, so a caller could rotate it per request and never hit the limit (found in review).
const ARM_THROTTLE_KEY = 'arm:global';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The kill switch.
 *   { action: "kill" }                    disarms every grant, expires every open action
 *   { action: "reset", armSecret }        lifts the switch; re-arms nothing
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { action?: unknown; armSecret?: unknown } | null;
  const approvals = getApprovals();
  if (body?.action === 'kill') {
    const r = approvals.kill('operator');
    return r.ok ? NextResponse.json(r) : refusalResponse(r);
  }
  if (body?.action === 'reset') {
    const r = approvals.reset(body.armSecret, 'operator', ARM_THROTTLE_KEY);
    return r.ok ? NextResponse.json(r) : refusalResponse(r);
  }
  return NextResponse.json({ error: 'action must be "kill" or "reset"', code: 'invalid' }, { status: 400 });
}
