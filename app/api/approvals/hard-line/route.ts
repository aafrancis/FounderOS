import { NextResponse } from 'next/server';
import { getApprovals, refusalResponse } from '@/lib/approvals-server';
import { hardLineExpiresAt, isHardLine } from '@/lib/approvals';
import { authorizePush } from '@/lib/push-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * The agent's door for hard-line requests (SH-0277), used by scripts/request-approval.
 * An agent has no operator session, so this path takes a bearer token
 * (HARDLINE_REQUEST_TOKEN, checked by lib/push-auth.ts; none configured means
 * operator session or loopback only). The token can only FILE a request and
 * READ its status. Approving needs the founder's passkey, which no token gives.
 *
 *   POST { summary, action, undo, proposedBy }   file a request (201)
 *   GET  ?id=<id>                                 its status: proposed | approved | rejected | expired
 *   GET                                           every open hard-line request
 */
export async function POST(req: Request) {
  const auth = authorizePush(req, 'HARDLINE_REQUEST_TOKEN');
  if (!auth.ok) return NextResponse.json({ error: auth.error, code: 'unauthorized' }, { status: auth.status });
  const body = await req.json().catch(() => null);
  const filed = getApprovals().requestHardLine(body);
  return filed.ok
    ? NextResponse.json({ ok: true, id: filed.action.id, status: filed.action.status, expiresAt: filed.expiresAt }, { status: 201 })
    : refusalResponse(filed);
}

export async function GET(req: Request) {
  const auth = authorizePush(req, 'HARDLINE_REQUEST_TOKEN');
  if (!auth.ok) return NextResponse.json({ error: auth.error, code: 'unauthorized' }, { status: auth.status });
  const approvals = getApprovals();
  const id = new URL(req.url).searchParams.get('id');
  if (!id) {
    const open = approvals
      .state()
      .open.filter(isHardLine)
      .map((a) => ({ id: a.id, summary: a.title, status: a.status, proposedBy: a.proposedBy, expiresAt: hardLineExpiresAt(a) }));
    return NextResponse.json({ open });
  }
  const r = approvals.status(id);
  if (!r.ok) return refusalResponse(r);
  if (!isHardLine(r.action)) return NextResponse.json({ error: 'not a hard-line request', code: 'not_hard_line' }, { status: 404 });
  return NextResponse.json({ id: r.action.id, status: r.action.status, decidedBy: r.action.decidedBy, decidedAt: r.action.decidedAt, expiresAt: r.expiresAt });
}
