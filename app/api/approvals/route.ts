import { NextResponse } from 'next/server';
import { armingConfigured } from '@/lib/approvals';
import { getDb } from '@/lib/data';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Queue overview: kill switch, grants, pending proposals and recent history. Read-only. */
export async function GET() {
  const repo = getDb().approvals;
  return NextResponse.json({
    switch: repo.switchState(),
    armingConfigured: armingConfigured(),
    grants: repo.grants(),
    pending: repo.list('pending'),
    recent: repo.list(undefined, 50),
    audit: repo.auditLog(50),
  });
}

/**
 * Propose an action (an agent or Wild Horse loop calls this). It never runs anything: a proposal is
 * refused unless its channel has an ARMED grant, the kill switch is released and today's caps allow it.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.channel !== 'string' || typeof body.summary !== 'string' || typeof body.target !== 'string') {
    return NextResponse.json({ error: 'channel, summary and target are required' }, { status: 400 });
  }
  const res = getDb().approvals.propose({
    channel: body.channel,
    summary: body.summary,
    target: body.target,
    payload: body.payload ?? null,
    costCents: typeof body.costCents === 'number' ? body.costCents : 0,
    proposedBy: typeof body.proposedBy === 'string' && body.proposedBy ? body.proposedBy.slice(0, 64) : 'agent',
  });
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 409 });
  return NextResponse.json({ approval: res.value }, { status: 201 });
}
