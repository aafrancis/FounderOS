import { getDb } from '@/lib/data';
import { createApprovals, type Approvals, type Refusal, type Result } from '@/lib/approvals';
import type { ApprovalAction } from '@/lib/db-ext/approvals';
import { NextResponse } from 'next/server';

/** The queue bound to this instance's database. */
export function getApprovals() {
  return createApprovals({ repo: getDb().approvals });
}

/** A refusal as a response; the code and plain-English reason travel with it. */
export function refusalResponse(r: Refusal): NextResponse {
  return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
}

/** One lockout for the whole instance (never keyed on a client-set header). */
export const ARM_THROTTLE_KEY = 'arm:global';

/** The response for a filed proposal: queued (201), or approved and run at once on an auto grant. */
export async function respondFiled(approvals: Approvals, filed: Result<{ action: ApprovalAction; autoApproved: boolean }>): Promise<NextResponse> {
  if (!filed.ok) return refusalResponse(filed);
  if (!filed.autoApproved) return NextResponse.json({ ok: true, action: filed.action, autoApproved: false }, { status: 201 });
  const ran = await approvals.execute(filed.action.id, 'auto');
  return NextResponse.json(
    { ok: true, action: ran.ok ? ran.action : filed.action, autoApproved: true, execution: ran.ok ? 'ran' : { code: ran.code, error: ran.error } },
    { status: 201 },
  );
}
