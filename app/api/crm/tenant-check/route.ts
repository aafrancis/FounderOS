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
  // Fake-user header only until IdP lands — refuse in production unless explicitly armed.
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.FO_FAKE_PRINCIPAL !== '1'
  ) {
    return NextResponse.json(
      { error: 'x-fo-principal disabled in production (IdP PARKED)' },
      { status: 403 },
    );
  }
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
  // Same case rules as principalFromHeader (lowercase).
  const tenant = String(body.tenant || '').trim().toLowerCase();
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
