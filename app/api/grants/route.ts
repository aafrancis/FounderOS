import { NextResponse } from 'next/server';
import { armingConfigured, checkArming } from '@/lib/approvals';
import { clientKey, clearFailures, recordFailure, throttled } from '@/lib/auth';
import { getDb } from '@/lib/data';
import { isConfirmed } from '@/lib/gates';
import type { GrantKind, GrantMode } from '@/lib/db-ext/approvals';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const repo = getDb().approvals;
  return NextResponse.json({ switch: repo.switchState(), armingConfigured: armingConfigured(), grants: repo.grants() });
}

/**
 * Grant admin: { action, confirm: true, ... }
 *   set      channel, kind, mode, dailyCapCount?, dailyCapCents?  (always leaves the grant disarmed)
 *   arm      channel, armingSecret                                (needs the arming secret, not the login password)
 *   disarm   channel
 *   kill                                                          (engage the kill switch; no secret, must always work)
 *   release  armingSecret                                         (release the kill switch)
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const repo = getDb().approvals;
  const action = body?.action;
  if (action === 'kill') {
    repo.setKilled(true, 'operator');
    return NextResponse.json({ switch: repo.switchState() });
  }
  if (!isConfirmed(body)) return NextResponse.json({ error: 'Send confirm: true.', needsConfirm: true }, { status: 409 });
  const channel = typeof body?.channel === 'string' ? body.channel : '';

  if (action === 'set') {
    const res = repo.setGrant(
      {
        channel,
        kind: body?.kind as GrantKind,
        mode: body?.mode as GrantMode,
        dailyCapCount: typeof body?.dailyCapCount === 'number' ? body.dailyCapCount : null,
        dailyCapCents: typeof body?.dailyCapCents === 'number' ? body.dailyCapCents : null,
      },
      'operator',
    );
    return res.ok ? NextResponse.json({ grant: res.value }) : NextResponse.json({ error: res.reason }, { status: 409 });
  }
  if (action === 'disarm') {
    const res = repo.disarmGrant(channel, 'operator');
    return res.ok ? NextResponse.json({ grant: res.value }) : NextResponse.json({ error: res.reason }, { status: 409 });
  }
  if (action === 'arm' || action === 'release') {
    const key = `arming:${clientKey(req)}`;
    if (throttled(key)) return NextResponse.json({ error: 'Too many wrong attempts; wait and retry.' }, { status: 429 });
    const wrong = checkArming(body?.armingSecret);
    if (wrong) {
      if (armingConfigured()) recordFailure(key);
      return NextResponse.json({ error: wrong }, { status: 403 });
    }
    clearFailures(key);
    if (action === 'release') {
      repo.setKilled(false, 'operator');
      return NextResponse.json({ switch: repo.switchState() });
    }
    const res = repo.armGrant(channel, 'operator');
    return res.ok ? NextResponse.json({ grant: res.value }) : NextResponse.json({ error: res.reason }, { status: 409 });
  }
  return NextResponse.json({ error: 'action must be set, arm, disarm, kill or release' }, { status: 400 });
}
