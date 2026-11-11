import { NextResponse } from 'next/server';
import { getPasskeys, refusalResponse } from '@/lib/approvals-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Approve one hard-line action with the founder's passkey (SH-0277).
 *   { step: "options" }              a fresh challenge bound to this action, single use, 5 minutes
 *   { step: "verify", response }     the signed assertion from navigator.credentials.get()
 * This is the only route that can set a hard-line action to approved; the
 * ordinary POST /api/approvals/:id refuses it with passkey_required.
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const body = (await req.json().catch(() => null)) as { step?: unknown; response?: unknown } | null;
  const passkeys = getPasskeys();
  if (body?.step === 'options') {
    const r = await passkeys.approvalOptions(params.id);
    return r.ok ? NextResponse.json({ ok: true, options: r.options, expiresAt: r.expiresAt }) : refusalResponse(r);
  }
  if (body?.step === 'verify') {
    const r = await passkeys.approve(params.id, body.response, 'founder');
    return r.ok ? NextResponse.json({ ok: true, action: r.action }) : refusalResponse(r);
  }
  return NextResponse.json({ error: 'step must be "options" or "verify"', code: 'invalid' }, { status: 400 });
}
