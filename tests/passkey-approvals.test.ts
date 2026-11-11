import { beforeEach, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '@/lib/db';
import { hashPassword, resetThrottle } from '@/lib/auth';
import { createApprovals, HARD_LINE_KIND, HARD_LINE_TTL_MS } from '@/lib/approvals';
import { CHALLENGE_TTL_MS, approvalChallenge, createPasskeys, type RpConfig } from '@/lib/passkeys';
import { assert, attest, newKey, type SoftKey } from './helpers/soft-authenticator';

/**
 * Hard-line approvals need the founder's passkey (SH-0277). Every check that
 * keeps a hard-line approval honest has a test here that goes red when the
 * check is removed: challenge binding, replay, expiry, wrong credential, and
 * "nothing else can set approved". A real P-256 software authenticator signs
 * the assertions, so @simplewebauthn/server verifies them for real.
 */

const ARM_PHRASE = 'open the gate for me';
const RP: RpConfig = { rpID: 'founderos.test', origins: ['https://founderos.test'], rpName: 'FounderOS' };
const ORIGIN = RP.origins[0];
let clock = new Date('2026-11-11T10:00:00Z');
let seq = 0;

function setup(file = ':memory:') {
  const db = openDb(file);
  const deps = { now: () => clock, armHash: () => hashPassword(ARM_PHRASE), loginHash: () => hashPassword('login phrase') };
  const approvals = createApprovals({ repo: db.approvals, writesOn: () => true, executors: new Map(), ...deps });
  const passkeys = createPasskeys({ repo: db.passkeys, approvals: db.approvals, rp: () => RP, nonce: () => `n${++seq}`, ...deps });
  return { db, approvals, passkeys };
}

/** Enrol `key` through the real registration flow (arming secret, attestation, verify). */
async function enrol(p: ReturnType<typeof setup>['passkeys'], key: SoftKey) {
  const start = await p.registrationOptions(ARM_PHRASE, 'founder', `k-${key.id}`);
  if (!start.ok) throw new Error(start.error);
  const done = await p.verifyRegistration(attest(key, { challenge: start.options.challenge, rpID: RP.rpID, origin: ORIGIN }), 'iPhone', 'founder');
  if (!done.ok) throw new Error(done.error);
}

function hardLine(a: ReturnType<typeof setup>['approvals'], summary = 'Force-push meta main') {
  const r = a.requestHardLine({ summary, action: 'git push --force origin main', undo: 'git push origin <old-sha>:main', proposedBy: 'agent:meta' });
  if (!r.ok) throw new Error(r.error);
  return r.action.id;
}

async function challengeFor(p: ReturnType<typeof setup>['passkeys'], id: string) {
  const o = await p.approvalOptions(id);
  if (!o.ok) throw new Error(o.error);
  return o.options.challenge;
}

let founder: SoftKey;
beforeEach(() => {
  clock = new Date('2026-11-11T10:00:00Z');
  resetThrottle();
  founder = newKey();
});

describe('the happy path', () => {
  test('a fresh assertion bound to the action approves it, and only that action', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const id = hardLine(approvals);
    const other = hardLine(approvals, 'Delete the old bucket');
    const challenge = await challengeFor(passkeys, id);
    const r = await passkeys.approve(id, assert(founder, { challenge, rpID: RP.rpID, origin: ORIGIN }), 'founder');
    expect(r.ok).toBe(true);
    expect(approvals.status(id)).toMatchObject({ ok: true, action: { status: 'approved' } });
    expect(approvals.status(id).ok && approvals.status(id)).toMatchObject({ action: { decidedBy: expect.stringMatching(/^passkey:/) } });
    expect(approvals.status(other)).toMatchObject({ ok: true, action: { status: 'proposed' } });
  });

  test('the challenge names the action id and is base64url', () => {
    expect(Buffer.from(approvalChallenge('abc', 'n1'), 'base64url').toString()).toBe('hard-line:abc:n1');
  });
});

describe('challenge binding', () => {
  test('an assertion over action A\'s challenge cannot approve action B', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const a = hardLine(approvals, 'A');
    const b = hardLine(approvals, 'B');
    const challengeA = await challengeFor(passkeys, a);
    await challengeFor(passkeys, b); // B has its own challenge outstanding too
    const r = await passkeys.approve(b, assert(founder, { challenge: challengeA, rpID: RP.rpID, origin: ORIGIN }), 'attacker');
    expect(r).toMatchObject({ ok: false, code: 'challenge_not_for_this_approval' });
    expect(approvals.status(b)).toMatchObject({ action: { status: 'proposed' } });
  });

  test('a challenge we never issued is refused, even if it names the action', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const id = hardLine(approvals);
    const forged = approvalChallenge(id, 'made-up-nonce');
    const r = await passkeys.approve(id, assert(founder, { challenge: forged, rpID: RP.rpID, origin: ORIGIN }), 'attacker');
    expect(r).toMatchObject({ ok: false, code: 'unknown_challenge' });
    expect(approvals.status(id)).toMatchObject({ action: { status: 'proposed' } });
  });
});

describe('replay', () => {
  test('the same signed assertion is refused the second time', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const id = hardLine(approvals);
    const challenge = await challengeFor(passkeys, id);
    const signed = assert(founder, { challenge, rpID: RP.rpID, origin: ORIGIN });
    expect((await passkeys.approve(id, signed, 'founder')).ok).toBe(true);
    expect(await passkeys.approve(id, signed, 'attacker')).toMatchObject({ ok: false });
  });

  test('a replayed assertion is refused by the single-use challenge even when the action is approvable again', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'glados-passkey-')), 'replay.db');
    const { approvals, passkeys } = setup(file);
    await enrol(passkeys, founder);
    const id = hardLine(approvals);
    const challenge = await challengeFor(passkeys, id);
    const signed = assert(founder, { challenge, rpID: RP.rpID, origin: ORIGIN });
    expect((await passkeys.approve(id, signed, 'founder')).ok).toBe(true);
    // Reopen the action behind the module's back, so the status check cannot
    // save us: the only thing left between the replay and approval is the challenge.
    const side = new Database(file);
    side.prepare("UPDATE approval_actions SET status = 'proposed' WHERE id = ?").run(id);
    side.close();
    expect(await passkeys.approve(id, signed, 'attacker')).toMatchObject({ ok: false, code: 'challenge_used' });
    expect(approvals.status(id)).toMatchObject({ action: { status: 'proposed' } });
  });
});

describe('expiry', () => {
  test('an assertion over a challenge older than 5 minutes is refused', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const id = hardLine(approvals);
    const challenge = await challengeFor(passkeys, id);
    clock = new Date(clock.getTime() + CHALLENGE_TTL_MS + 1000);
    const r = await passkeys.approve(id, assert(founder, { challenge, rpID: RP.rpID, origin: ORIGIN }), 'founder');
    expect(r).toMatchObject({ ok: false, code: 'challenge_expired' });
    expect(approvals.status(id)).toMatchObject({ action: { status: 'proposed' } });
  });

  test('a hard-line request nobody approves expires after its TTL and can no longer be approved', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const id = hardLine(approvals);
    clock = new Date(clock.getTime() + HARD_LINE_TTL_MS + 1000);
    expect(approvals.status(id)).toMatchObject({ ok: true, action: { status: 'expired' } });
    expect(await passkeys.approvalOptions(id)).toMatchObject({ ok: false, code: 'not_proposed' });
  });
});

describe('wrong credential', () => {
  test('an assertion from a passkey that was never registered is refused', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const stranger = newKey();
    const id = hardLine(approvals);
    const challenge = await challengeFor(passkeys, id);
    const r = await passkeys.approve(id, assert(stranger, { challenge, rpID: RP.rpID, origin: ORIGIN }), 'attacker');
    expect(r).toMatchObject({ ok: false, code: 'unknown_credential' });
    expect(approvals.status(id)).toMatchObject({ action: { status: 'proposed' } });
  });

  test('another key signing under the founder\'s credential id fails signature verification', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const stranger = newKey();
    const id = hardLine(approvals);
    const challenge = await challengeFor(passkeys, id);
    const r = await passkeys.approve(id, assert(stranger, { challenge, rpID: RP.rpID, origin: ORIGIN, asId: founder.id }), 'attacker');
    expect(r).toMatchObject({ ok: false, code: 'assertion_invalid' });
    expect(approvals.status(id)).toMatchObject({ action: { status: 'proposed' } });
  });

  test('an assertion without user verification (no Face ID) is refused', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const id = hardLine(approvals);
    const challenge = await challengeFor(passkeys, id);
    const r = await passkeys.approve(id, assert(founder, { challenge, rpID: RP.rpID, origin: ORIGIN, uv: false }), 'founder');
    expect(r).toMatchObject({ ok: false, code: 'assertion_invalid' });
  });

  test('an assertion made for another origin is refused', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    const id = hardLine(approvals);
    const challenge = await challengeFor(passkeys, id);
    const r = await passkeys.approve(id, assert(founder, { challenge, rpID: RP.rpID, origin: 'https://evil.test' }), 'founder');
    expect(r).toMatchObject({ ok: false, code: 'assertion_invalid' });
  });
});

describe('no other door sets approved on a hard-line action', () => {
  test('decide(approve) is refused with passkey_required; deny (reject) still works', () => {
    const { approvals } = setup();
    const id = hardLine(approvals);
    expect(approvals.decide(id, 'approve', 'operator')).toMatchObject({ ok: false, code: 'passkey_required' });
    expect(approvals.status(id)).toMatchObject({ action: { status: 'proposed' } });
    expect(approvals.decide(id, 'reject', 'operator')).toMatchObject({ ok: true, action: { status: 'rejected' } });
  });

  test('a hard-line kind filed through the ordinary door is refused, even on an auto grant', () => {
    const { approvals } = setup();
    expect(approvals.arm({ channel: 'ops', mode: 'auto', dailyCapCount: 10, dailyCapCents: 0 }, ARM_PHRASE, 'operator', 'k').ok).toBe(true);
    const r = approvals.propose({ channel: 'ops', kind: HARD_LINE_KIND, title: 't', content: 'c', target: 'x', costCents: 0, proposedBy: 'agent' });
    expect(r).toMatchObject({ ok: false, code: 'hard_line_use_request' });
  });

  test('storage refuses transition(proposed -> approved) on a hard-line row', () => {
    const { db, approvals } = setup();
    const id = hardLine(approvals);
    expect(db.approvals.transition(id, 'proposed', 'approved', { at: clock.toISOString(), by: 'agent' })).toBe(false);
    expect(approvals.status(id)).toMatchObject({ action: { status: 'proposed' } });
  });

  test('registering a passkey needs the arming secret', async () => {
    const { passkeys } = setup();
    expect(await passkeys.registrationOptions('guess', 'agent', 'k-reg')).toMatchObject({ ok: false, code: 'bad_arm_secret' });
    expect(passkeys.status().credentials).toHaveLength(0);
  });
});

describe('non-hard-line approvals are unaffected', () => {
  test('an ordinary ask-mode action is approved by the operator without any passkey', async () => {
    const { approvals } = setup();
    expect(approvals.arm({ channel: 'email', mode: 'ask', dailyCapCount: 5, dailyCapCents: 0 }, ARM_PHRASE, 'operator', 'k').ok).toBe(true);
    const filed = approvals.propose({ channel: 'email', kind: 'send-email', title: 'Hi', content: 'Body', target: 'a@example.com', costCents: 0, proposedBy: 'agent' });
    expect(filed.ok).toBe(true);
    const id = (filed as { action: { id: string } }).action.id;
    expect(approvals.decide(id, 'approve', 'operator')).toMatchObject({ ok: true, action: { status: 'approved' } });
  });

  test('an ordinary auto grant still auto-approves', () => {
    const { approvals } = setup();
    approvals.arm({ channel: 'posts', mode: 'auto', dailyCapCount: 5, dailyCapCents: 0 }, ARM_PHRASE, 'operator', 'k');
    const filed = approvals.propose({ channel: 'posts', kind: 'publish', title: 'Post', content: 'Body', target: 'x', costCents: 0, proposedBy: 'agent' });
    expect(filed).toMatchObject({ ok: true, autoApproved: true, action: { status: 'approved' } });
  });

  test('a passkey cannot be used to approve a non-hard-line action', async () => {
    const { approvals, passkeys } = setup();
    await enrol(passkeys, founder);
    approvals.arm({ channel: 'email', mode: 'ask', dailyCapCount: 5, dailyCapCents: 0 }, ARM_PHRASE, 'operator', 'k');
    const filed = approvals.propose({ channel: 'email', kind: 'send-email', title: 'Hi', content: 'Body', target: 'a@example.com', costCents: 0, proposedBy: 'agent' });
    const id = (filed as { action: { id: string } }).action.id;
    expect(await passkeys.approvalOptions(id)).toMatchObject({ ok: false, code: 'not_hard_line' });
  });
});
