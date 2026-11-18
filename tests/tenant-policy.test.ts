import { describe, it, expect } from 'vitest';
import {
  assertSuiteNegatives,
  canRead,
  josh,
  adrien,
  principalFromHeader,
} from '@/lib/tenant-policy';

describe('tenant-policy FounderOS CRM (SH-0271 W3b)', () => {
  it('passes suite negatives', () => {
    expect(assertSuiteNegatives()).toEqual([]);
  });

  it('blocks Josh CRM outside letsloop', () => {
    expect(canRead(josh(), { tenant: 'propersites', resource: 'crm' })).toBe(false);
    expect(canRead(josh(), { tenant: 'letsloop', resource: 'crm' })).toBe(true);
  });

  it('allows Adrien CRM cross-tenant', () => {
    expect(canRead(adrien(), { tenant: 'propersites', resource: 'crm' })).toBe(true);
  });

  it('reads x-fo-principal while IdP PARKED', () => {
    expect(principalFromHeader('josh')?.userId).toBe('josh');
  });
});
