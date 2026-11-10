import { NextResponse } from 'next/server';
import { getApprovals, respondFiled } from '@/lib/approvals-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** The queue: kill switch, grants, open and recent actions, the newest log lines. */
export async function GET() {
  return NextResponse.json(getApprovals().state());
}

/**
 * File an action. Refused unless its channel has an armed grant. On an `auto`
 * grant the action is approved and run at once; on `ask` it waits in the queue
 * for the operator (POST /api/approvals/:id).
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const approvals = getApprovals();
  return respondFiled(approvals, approvals.propose(body));
}
