import { NextRequest, NextResponse } from 'next/server';
import {
  canRead,
  principalFromHeader,
  type Resource,
} from '@/lib/tenant-policy';

export const dynamic = 'force-dynamic';

const RESOURCES = new Set<Resource>([
  'revenue',
  'crm',
  'fleet',
  'hookify_tenant',
  'meeting',
]);

/**
 * SH-0271 W3b — FounderOS CRM membership check.
 * Fake-user via x-fo-principal while IdP is PARKED.
 */
export async function POST(req: NextRequest) {
  const principal = principalFromHeader(req.headers.get('x-fo-principal'));
  if (!principal) {
    return NextResponse.json(
      { error: 'x-fo-principal required (josh|adrien|client:<tenant>) while IdP PARKED' },
      { status: 401 },
    );
  }
  const body = (await req.json().catch(() => ({}))) as {
    tenant?: string;
    resource?: string;
  };
  const tenant = String(body.tenant || '');
  const resource = String(body.resource || '') as Resource;
  if (!tenant || !RESOURCES.has(resource)) {
    return NextResponse.json({ error: 'tenant and resource required' }, { status: 400 });
  }
  const allowed = canRead(principal, { tenant, resource });
  if (!allowed) {
    return NextResponse.json(
      { allowed: false, error: 'forbidden', principal: principal.userId, tenant, resource },
      { status: 403 },
    );
  }
  return NextResponse.json({
    allowed: true,
    principal: principal.userId,
    tenant,
    resource,
  });
}
