import { getDb } from '@/lib/data';
import { createApprovals, type Refusal } from '@/lib/approvals';
import { NextResponse } from 'next/server';

/** The queue bound to this instance's database. */
export function getApprovals() {
  return createApprovals({ repo: getDb().approvals });
}

/** A refusal as a response; the code and plain-English reason travel with it. */
export function refusalResponse(r: Refusal): NextResponse {
  return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
}
