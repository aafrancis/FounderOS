import { describe, expect, test } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buttonsFor, errorText, formatCents, headline, whyNotRunning, type ViewState } from '@/lib/approvals-view';
import { NAV_EXTRA, NAV_ITEMS } from '@/lib/nav';

const base: ViewState = { killed: false, writesEnabled: true, armConfigured: true, grants: [], open: [], recent: [] };
const armed = { channel: 'c', mode: 'ask' as const, armed: true, dailyCapCount: 1, dailyCapCents: 0 };

describe('approvals view rules', () => {
  test('cents print as a plain two-decimal number, never negative or NaN', () => {
    expect(formatCents(0)).toBe('0.00');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(1250)).toBe('12.50');
    expect(formatCents(-40)).toBe('0.00');
    expect(formatCents(Number.NaN)).toBe('0.00');
  });

  test('buttons: a proposal can be approved or rejected, an approved one can be run, the rest have none', () => {
    expect(buttonsFor({ status: 'proposed' }, false)).toEqual(['approve', 'reject']);
    expect(buttonsFor({ status: 'approved' }, false)).toEqual(['run']);
    for (const s of ['rejected', 'executing', 'executed', 'failed', 'expired'] as const) expect(buttonsFor({ status: s }, false)).toEqual([]);
  });

  test('with the kill switch on there are no buttons at all', () => {
    expect(buttonsFor({ status: 'proposed' }, true)).toEqual([]);
    expect(buttonsFor({ status: 'approved' }, true)).toEqual([]);
  });

  test('why an approved action waits: kill, writes off, or ready; nothing for other states', () => {
    expect(whyNotRunning({ killed: true, writesEnabled: true }, { status: 'approved' })).toMatch(/kill switch/i);
    expect(whyNotRunning({ killed: false, writesEnabled: false }, { status: 'approved' })).toMatch(/writes are off/i);
    expect(whyNotRunning({ killed: false, writesEnabled: true }, { status: 'approved' })).toMatch(/Run/);
    expect(whyNotRunning({ killed: false, writesEnabled: true }, { status: 'proposed' })).toBeNull();
  });

  test('headline is red when killed, amber without an arming secret, green when nothing is armed, amber with channels armed', () => {
    expect(headline({ ...base, killed: true }).tone).toBe('bad');
    expect(headline({ ...base, armConfigured: false }).tone).toBe('warn');
    expect(headline(base)).toMatchObject({ tone: 'ok', text: expect.stringMatching(/No channel is armed/) });
    expect(headline({ ...base, grants: [armed] })).toMatchObject({ tone: 'warn', text: '1 channel armed.' });
    expect(headline({ ...base, grants: [armed, { ...armed, channel: 'd' }] }).text).toBe('2 channels armed.');
    expect(headline({ ...base, grants: [{ ...armed, armed: false }] }).tone).toBe('ok');
  });

  test('error text uses the API sentence, else the fallback', () => {
    expect(errorText({ error: 'The arming secret is wrong.' }, 'x')).toBe('The arming secret is wrong.');
    expect(errorText(null, 'fallback')).toBe('fallback');
    expect(errorText({ error: 5 }, 'fallback')).toBe('fallback');
  });
});

describe('the approvals screen is wired in', () => {
  test('page exists and the nav knows it without disturbing the sidebar count', () => {
    expect(existsSync(path.join(process.cwd(), 'app/approvals/page.tsx'))).toBe(true);
    expect(NAV_EXTRA.map((i) => i.href)).toContain('/approvals');
    expect(NAV_ITEMS.map((i) => i.href)).not.toContain('/approvals');
  });

  test('the panel keeps the arming password out of state, storage and the URL', () => {
    const src = readFileSync(path.join(process.cwd(), 'components/approvals/ApprovalsPanel.tsx'), 'utf8');
    expect(src).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    expect(src).not.toMatch(/useState[^\n]*[Ss]ecret/);
    expect(src).toMatch(/type="password"/);
    expect(src).toMatch(/form\.reset\(\)/);
  });
});
