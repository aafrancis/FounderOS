import { getDb } from '@/lib/data';
import { createApprovals, type Refusal } from '@/lib/approvals';
import { createPasskeys } from '@/lib/passkeys';
import { NextResponse } from 'next/server';

/** The queue bound to this instance's database. */
export function getApprovals() {
  return createApprovals({ repo: getDb().approvals });
}

/** The founder's passkeys, bound to the same database as the queue (SH-0277). */
export function getPasskeys() {
  const db = getDb();
  return createPasskeys({ repo: db.passkeys, approvals: db.approvals });
}

/** A refusal as a response; the code and plain-English reason travel with it. */
export function refusalResponse(r: Refusal): NextResponse {
  return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
}
