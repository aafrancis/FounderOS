import { NextResponse } from 'next/server';
import { getPasskeys, refusalResponse } from '@/lib/approvals-server';

// One lockout for the whole instance, shared with arming (never keyed on x-forwarded-for).
const ARM_THROTTLE_KEY = 'arm:global';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Is passkey approval set up, and which passkeys are registered (ids and labels only). */
export async function GET() {
  return NextResponse.json(getPasskeys().status());
}

/**
 * Register the founder's passkey (SH-0277).
 *   { step: "options", armSecret }         needs the arming secret, not the login password
 *   { step: "verify", response, label }    the attestation from navigator.credentials.create()
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { step?: unknown; armSecret?: unknown; response?: unknown; label?: unknown } | null;
  const passkeys = getPasskeys();
  if (body?.step === 'options') {
    const r = await passkeys.registrationOptions(body.armSecret, 'operator', ARM_THROTTLE_KEY);
    return r.ok ? NextResponse.json({ ok: true, options: r.options }) : refusalResponse(r);
  }
  if (body?.step === 'verify') {
    const r = await passkeys.verifyRegistration(body.response, body.label, 'operator');
    return r.ok ? NextResponse.json({ ok: true, credentialId: r.credentialId }) : refusalResponse(r);
  }
  return NextResponse.json({ error: 'step must be "options" or "verify"', code: 'invalid' }, { status: 400 });
}
