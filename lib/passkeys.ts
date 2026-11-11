/**
 * Passkey (WebAuthn) approvals for hard-line actions (SH-0277, founder
 * decisions 2026-11-10 and 2026-11-11).
 *
 * One user: the founder. Their passkey lives on their phone (Face ID) and only
 * its public key is stored here. A hard-line action becomes approved only when
 * this module has verified a FRESH assertion whose challenge was issued for
 * that exact action id:
 *
 *   challenge   base64url("hard-line:<action id>:<random nonce>"), stored with
 *               the action id, single use, expires after 5 minutes.
 *   binding     the challenge in the signed clientDataJSON must be one we issued
 *               for THIS action id (stored row and decoded prefix both checked).
 *   replay      the challenge is consumed compare-and-set before verifying, so
 *               one assertion can never approve twice.
 *   credential  the assertion must come from a registered credential and verify
 *               against its stored public key, with user verification (Face ID).
 *
 * Registering a passkey needs the arming secret (GLADOS_ARM_HASH), which is not
 * the login password, so a stolen session cookie cannot enrol its own key.
 *
 * Trust limit, said plainly: agents have root on this host, so they can edit
 * this file or the database. The passkey proves the founder pressed Approve for
 * that exact action; it does not stop a rogue root agent changing the server.
 * See docs/passkey-approvals.md for the follow-up that closes this.
 *
 * Library: @simplewebauthn/server (MIT), pinned in package.json.
 */
import { randomBytes } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { clearFailures, readAuthState, recordFailure, throttled, verifyPassword } from '@/lib/auth';
import { resolveCred } from '@/lib/creds';
import { ARM_HASH_KEY, HARD_LINE_TTL_MS, isHardLine, type Refusal, type Result } from '@/lib/approvals';
import type { ApprovalAction, approvalsRepo } from '@/lib/db-ext/approvals';
import type { PasskeyCredential, passkeysRepo } from '@/lib/db-ext/passkeys';

export const RP_ID_KEY = 'GLADOS_PASSKEY_RP_ID';
export const RP_ORIGIN_KEY = 'GLADOS_PASSKEY_ORIGIN';
export const RP_NAME_KEY = 'GLADOS_PASSKEY_RP_NAME';

/** A challenge is good for this long, and once. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_PREFIX = 'hard-line:';
const FOUNDER_USER_ID = new TextEncoder().encode('founderos-founder');

export type RpConfig = { rpID: string; origins: string[]; rpName: string };

/** Relying party from env (or .env.local). Origins are a comma-separated list. Null = not configured. */
export function rpFromEnv(): RpConfig | null {
  const rpID = resolveCred(RP_ID_KEY, [])?.trim();
  const origins = (resolveCred(RP_ORIGIN_KEY, []) ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (!rpID || origins.length === 0) return null;
  return { rpID, origins, rpName: resolveCred(RP_NAME_KEY, [])?.trim() || 'FounderOS' };
}

export type PasskeyDeps = {
  repo: ReturnType<typeof passkeysRepo>;
  approvals: ReturnType<typeof approvalsRepo>;
  rp?: () => RpConfig | null;
  now?: () => Date;
  armHash?: () => string | undefined;
  loginHash?: () => string | undefined;
  nonce?: () => string;
};

const refuse = (status: number, code: string, error: string): Refusal => ({ ok: false, status, code, error });

/** The challenge string inside a base64url-encoded clientDataJSON, or null if it is not one. */
export function challengeOf(clientDataJSON: unknown): string | null {
  if (typeof clientDataJSON !== 'string') return null;
  try {
    const parsed = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
    return typeof parsed.challenge === 'string' && parsed.challenge ? parsed.challenge : null;
  } catch {
    return null;
  }
}

/** The bytes we sign for one approval: "hard-line:<id>:<nonce>", base64url. */
export function approvalChallenge(actionId: string, nonce: string): string {
  return Buffer.from(`${CHALLENGE_PREFIX}${actionId}:${nonce}`, 'utf8').toString('base64url');
}

/** Does this base64url challenge decode to one minted for `actionId`? */
export function challengeNamesAction(challenge: string, actionId: string): boolean {
  const text = Buffer.from(challenge, 'base64url').toString('utf8');
  return text.startsWith(`${CHALLENGE_PREFIX}${actionId}:`) && text.length > CHALLENGE_PREFIX.length + actionId.length + 1;
}

export function createPasskeys(deps: PasskeyDeps) {
  const { repo, approvals } = deps;
  const rp = deps.rp ?? rpFromEnv;
  const now = () => (deps.now ? deps.now() : new Date());
  const iso = () => now().toISOString();
  const armHash = deps.armHash ?? (() => resolveCred(ARM_HASH_KEY, [])?.trim() || undefined);
  const loginHash = deps.loginHash ?? (() => readAuthState().passwordHash);
  const nonce = deps.nonce ?? (() => randomBytes(18).toString('base64url'));

  const notConfigured = () =>
    refuse(503, 'passkey_not_configured', `Passkeys are not set up: set ${RP_ID_KEY} (e.g. founderos.example.com) and ${RP_ORIGIN_KEY} (e.g. https://founderos.example.com) in .env.local.`);

  function log(event: string, actor: string, actionId: string | null, detail: string) {
    approvals.log({ at: iso(), event, actor, channel: 'hard-line', actionId, detail });
  }

  /** Is this hard-line action approvable right now? */
  function approvable(actionId: string): Refusal | { ok: true; action: ApprovalAction } {
    approvals.expireHardLine(new Date(now().getTime() - HARD_LINE_TTL_MS).toISOString(), iso());
    const action = approvals.action(actionId);
    if (!action) return refuse(404, 'unknown', 'No such action.');
    if (!isHardLine(action)) return refuse(400, 'not_hard_line', 'Only hard-line actions are approved with a passkey.');
    if (approvals.switchState().killed) return refuse(423, 'killed', 'The kill switch is on. Nothing can be approved.');
    if (action.status !== 'proposed') return refuse(409, 'not_proposed', `This action is already ${action.status}.`);
    return { ok: true, action };
  }

  return {
    status(): { configured: boolean; rpID: string | null; credentials: Pick<PasskeyCredential, 'id' | 'label' | 'createdAt' | 'lastUsedAt'>[] } {
      const cfg = rp();
      return {
        configured: Boolean(cfg),
        rpID: cfg?.rpID ?? null,
        credentials: repo.credentials().map((c) => ({ id: c.id, label: c.label, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt })),
      };
    },

    /** Start enrolling a passkey. Needs the arming secret. */
    async registrationOptions(armSecret: unknown, actor: string, throttleKey: string): Promise<Result<{ options: PublicKeyCredentialCreationOptionsJSON }>> {
      const cfg = rp();
      if (!cfg) return notConfigured();
      const hash = armHash();
      if (!hash) return refuse(503, 'arming_not_configured', 'No arming secret is set (GLADOS_ARM_HASH), so no passkey can be enrolled.');
      if (throttled(throttleKey)) return refuse(429, 'throttled', 'Too many wrong arming secrets. Wait about a minute.');
      if (typeof armSecret !== 'string' || !verifyPassword(armSecret, hash)) {
        recordFailure(throttleKey);
        log('passkey_register_refused', actor, null, 'wrong arming secret');
        return refuse(401, 'bad_arm_secret', 'The arming secret is wrong.');
      }
      const login = loginHash();
      if (login && verifyPassword(armSecret, login)) return refuse(403, 'arm_secret_is_login_password', 'The arming secret must differ from the login password.');
      clearFailures(throttleKey);
      const options = await generateRegistrationOptions({
        rpName: cfg.rpName,
        rpID: cfg.rpID,
        userName: 'founder',
        userDisplayName: 'Founder',
        userID: FOUNDER_USER_ID,
        attestationType: 'none',
        excludeCredentials: repo.credentials().map((c) => ({ id: c.id, transports: c.transports })),
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        timeout: CHALLENGE_TTL_MS,
      });
      repo.insertChallenge({ challenge: options.challenge, purpose: 'register', approvalId: null, createdAt: iso(), expiresAt: new Date(now().getTime() + CHALLENGE_TTL_MS).toISOString() });
      return { ok: true, options };
    },

    /** Finish enrolling: verify the attestation against a register challenge we issued, store the public key. */
    async verifyRegistration(response: unknown, label: unknown, actor: string): Promise<Result<{ credentialId: string }>> {
      const cfg = rp();
      if (!cfg) return notConfigured();
      const r = response as RegistrationResponseJSON | null;
      const challenge = challengeOf(r?.response?.clientDataJSON);
      const row = challenge ? repo.challenge(challenge) : null;
      if (!row || row.purpose !== 'register') return refuse(401, 'unknown_challenge', 'That registration was not started here. Start again.');
      if (row.usedAt) return refuse(409, 'challenge_used', 'That registration challenge was already used. Start again.');
      if (Date.parse(row.expiresAt) <= now().getTime()) return refuse(401, 'challenge_expired', 'That registration took longer than 5 minutes. Start again.');
      if (!repo.consumeChallenge(row.challenge, iso())) return refuse(409, 'challenge_used', 'That registration challenge was already used. Start again.');
      let verified;
      try {
        verified = await verifyRegistrationResponse({
          response: r!,
          expectedChallenge: row.challenge,
          expectedOrigin: cfg.origins,
          expectedRPID: cfg.rpID,
          requireUserVerification: true,
        });
      } catch (e) {
        log('passkey_register_refused', actor, null, e instanceof Error ? e.message.slice(0, 200) : 'invalid');
        return refuse(400, 'registration_invalid', 'The passkey registration did not verify.');
      }
      if (!verified.verified) return refuse(400, 'registration_invalid', 'The passkey registration did not verify.');
      const c = verified.registrationInfo.credential;
      if (repo.credential(c.id)) return refuse(409, 'already_registered', 'That passkey is already registered.');
      const name = typeof label === 'string' && label.trim() ? label.trim().slice(0, 60) : 'passkey';
      repo.insertCredential({ id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [], label: name, createdAt: iso() });
      log('passkey_registered', actor, null, `${name} (${c.id.slice(0, 10)})`);
      return { ok: true, credentialId: c.id };
    },

    /** A fresh, single-use challenge bound to this one hard-line action. */
    async approvalOptions(actionId: string): Promise<Result<{ options: PublicKeyCredentialRequestOptionsJSON; expiresAt: string }>> {
      const cfg = rp();
      if (!cfg) return notConfigured();
      const ok = approvable(actionId);
      if (!ok.ok) return ok;
      const creds = repo.credentials();
      if (creds.length === 0) return refuse(409, 'no_passkey', 'No passkey is registered yet. Register one on this page first.');
      const challenge = approvalChallenge(actionId, nonce());
      const options = await generateAuthenticationOptions({
        rpID: cfg.rpID,
        challenge: new Uint8Array(Buffer.from(challenge, 'base64url')),
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: 'required',
        timeout: CHALLENGE_TTL_MS,
      });
      const expiresAt = new Date(now().getTime() + CHALLENGE_TTL_MS).toISOString();
      repo.insertChallenge({ challenge: options.challenge, purpose: 'approve', approvalId: actionId, createdAt: iso(), expiresAt });
      return { ok: true, options, expiresAt };
    },

    /** Approve one hard-line action with a passkey assertion. The only way it becomes approved. */
    async approve(actionId: string, response: unknown, actor: string): Promise<Result<{ action: ApprovalAction }>> {
      const cfg = rp();
      if (!cfg) return notConfigured();
      const ok = approvable(actionId);
      if (!ok.ok) return ok;
      const a = response as AuthenticationResponseJSON | null;
      const challenge = challengeOf(a?.response?.clientDataJSON);
      if (!a || typeof a.id !== 'string' || !challenge) return refuse(400, 'invalid', 'A passkey assertion is required.');

      // Binding: we issued this challenge, for approval, for THIS action.
      const row = repo.challenge(challenge);
      if (!row || row.purpose !== 'approve') {
        log('passkey_refused', actor, actionId, 'unknown challenge');
        return refuse(401, 'unknown_challenge', 'That passkey prompt was not issued here. Try again.');
      }
      if (row.approvalId !== actionId || !challengeNamesAction(row.challenge, actionId)) {
        log('passkey_refused', actor, actionId, `challenge was issued for ${row.approvalId ?? 'nothing'}`);
        return refuse(403, 'challenge_not_for_this_approval', 'That passkey prompt was for a different approval.');
      }
      // Replay: one challenge, one use.
      if (row.usedAt) {
        log('passkey_refused', actor, actionId, 'challenge replayed');
        return refuse(409, 'challenge_used', 'That passkey prompt was already used. Press Approve again.');
      }
      // Freshness: 5 minutes.
      if (Date.parse(row.expiresAt) <= now().getTime()) {
        log('passkey_refused', actor, actionId, 'challenge expired');
        return refuse(401, 'challenge_expired', 'That passkey prompt is more than 5 minutes old. Press Approve again.');
      }
      if (!repo.consumeChallenge(row.challenge, iso())) {
        log('passkey_refused', actor, actionId, 'challenge replayed (race)');
        return refuse(409, 'challenge_used', 'That passkey prompt was already used. Press Approve again.');
      }
      // Credential: one the founder registered.
      const credential = repo.credential(a.id);
      if (!credential) {
        log('passkey_refused', actor, actionId, `unknown credential ${a.id.slice(0, 10)}`);
        return refuse(403, 'unknown_credential', 'That passkey is not registered here.');
      }
      let verified;
      try {
        verified = await verifyAuthenticationResponse({
          response: a,
          expectedChallenge: row.challenge,
          expectedOrigin: cfg.origins,
          expectedRPID: cfg.rpID,
          credential: { id: credential.id, publicKey: credential.publicKey as Uint8Array<ArrayBuffer>, counter: credential.counter, transports: credential.transports as never },
          requireUserVerification: true,
        });
      } catch (e) {
        log('passkey_refused', actor, actionId, e instanceof Error ? e.message.slice(0, 200) : 'invalid assertion');
        return refuse(401, 'assertion_invalid', 'The passkey signature did not verify.');
      }
      if (!verified.verified || !verified.authenticationInfo.userVerified) {
        log('passkey_refused', actor, actionId, 'not verified');
        return refuse(401, 'assertion_invalid', 'The passkey signature did not verify.');
      }
      repo.touchCredential(credential.id, verified.authenticationInfo.newCounter, iso());
      const by = `passkey:${credential.id.slice(0, 10)}`;
      if (!approvals.approveHardLineWithPasskey(actionId, iso(), by)) return refuse(409, 'not_proposed', 'This action was decided a moment ago.');
      log('approved', by, actionId, `passkey ${credential.label}`);
      return { ok: true, action: approvals.action(actionId)! };
    },
  };
}

export type Passkeys = ReturnType<typeof createPasskeys>;
