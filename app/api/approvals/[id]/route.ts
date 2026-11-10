import { NextResponse } from 'next/server';
import { runApproved } from '@/lib/approvals';
import { getDb } from '@/lib/data';
import { isConfirmed } from '@/lib/gates';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Decide or run one proposal: { action: "approve" | "reject" | "execute", confirm: true }.
 * Every action needs an explicit confirm:true (409 without it). Execute runs the approved action once.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  if (!isConfirmed(body)) return NextResponse.json({ error: 'Send confirm: true to act on a proposal.', needsConfirm: true }, { status: 409 });
  const repo = getDb().approvals;
  const action = body?.action;
  if (action === 'approve' || action === 'reject') {
    const res = action === 'approve' ? repo.approve(params.id, 'operator') : repo.reject(params.id, 'operator');
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 });
    return NextResponse.json({ approval: res.value });
  }
  if (action === 'execute') {
    const res = await runApproved(params.id, 'operator');
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 });
    return NextResponse.json({ approval: res.approval });
  }
  return NextResponse.json({ error: 'action must be approve, reject or execute' }, { status: 400 });
}
