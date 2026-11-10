import { NextResponse } from 'next/server';
import { getApprovals, refusalResponse } from '@/lib/approvals-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The operator decides one queued action: { decision: "approve" | "reject" }.
 * Approve re-checks the kill switch, the grant and the daily cap, then runs the
 * action once. If it cannot run (writes off, no executor) it stays approved and
 * the reason comes back in `execution`.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => null)) as { decision?: unknown } | null;
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return NextResponse.json({ error: 'decision must be "approve" or "reject"', code: 'invalid' }, { status: 400 });
  }
  const approvals = getApprovals();
  const decided = approvals.decide(params.id, decision, 'operator');
  if (!decided.ok) return refusalResponse(decided);
  if (decision === 'reject') return NextResponse.json({ ok: true, action: decided.action });
  const ran = await approvals.execute(params.id, 'operator');
  return NextResponse.json({
    ok: true,
    action: ran.ok ? ran.action : decided.action,
    execution: ran.ok ? 'ran' : { code: ran.code, error: ran.error },
  });
}
