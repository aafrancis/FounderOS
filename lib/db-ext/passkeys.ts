/**
 * Passkey storage (SH-0277): the founder's WebAuthn credentials and the
 * single-use challenges handed out for registration and for hard-line approvals.
 *
 * Only the credential PUBLIC key is stored. The private key never leaves the
 * founder's device (Face ID on iPhone). The rules live in lib/passkeys.ts.
 */
import type Database from 'better-sqlite3';

export type PasskeyCredential = {
  id: string; // base64url credential id
  publicKey: Uint8Array; // COSE public key
  counter: number;
  transports: string[];
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type ChallengePurpose = 'register' | 'approve';

export type PasskeyChallenge = {
  challenge: string; // base64url, exactly as sent to the browser
  purpose: ChallengePurpose;
  approvalId: string | null;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
};

type RawCredential = {
  id: string; public_key: Buffer; counter: number; transports: string; label: string; created_at: string; last_used_at: string | null;
};
type RawChallenge = {
  challenge: string; purpose: string; approval_id: string | null; created_at: string; expires_at: string; used_at: string | null;
};

const toCredential = (r: RawCredential): PasskeyCredential => ({
  id: r.id,
  publicKey: new Uint8Array(r.public_key),
  counter: r.counter,
  transports: r.transports ? (JSON.parse(r.transports) as string[]) : [],
  label: r.label,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});
const toChallenge = (r: RawChallenge): PasskeyChallenge => ({
  challenge: r.challenge, purpose: r.purpose as ChallengePurpose, approvalId: r.approval_id,
  createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at,
});

export const PASSKEYS_DDL = `
CREATE TABLE IF NOT EXISTS passkey_credentials (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS passkey_challenges (
  challenge TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('register','approve')),
  approval_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
`;

export function passkeysRepo(db: InstanceType<typeof Database>) {
  return {
    credentials(): PasskeyCredential[] {
      return (db.prepare('SELECT * FROM passkey_credentials ORDER BY created_at').all() as RawCredential[]).map(toCredential);
    },
    credential(id: string): PasskeyCredential | null {
      const r = db.prepare('SELECT * FROM passkey_credentials WHERE id = ?').get(id) as RawCredential | undefined;
      return r ? toCredential(r) : null;
    },
    insertCredential(c: { id: string; publicKey: Uint8Array; counter: number; transports: string[]; label: string; createdAt: string }): void {
      db.prepare(
        'INSERT INTO passkey_credentials (id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(c.id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports), c.label, c.createdAt);
    },
    touchCredential(id: string, counter: number, at: string): void {
      db.prepare('UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE id = ?').run(counter, at, id);
    },

    insertChallenge(c: { challenge: string; purpose: ChallengePurpose; approvalId: string | null; createdAt: string; expiresAt: string }): void {
      db.prepare(
        'INSERT INTO passkey_challenges (challenge, purpose, approval_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      ).run(c.challenge, c.purpose, c.approvalId, c.createdAt, c.expiresAt);
    },
    challenge(challenge: string): PasskeyChallenge | null {
      const r = db.prepare('SELECT * FROM passkey_challenges WHERE challenge = ?').get(challenge) as RawChallenge | undefined;
      return r ? toChallenge(r) : null;
    },
    /**
     * Mark a challenge used, compare-and-set. True only for the first caller,
     * so one assertion can never be spent twice (replay), even by two racing
     * requests.
     */
    consumeChallenge(challenge: string, at: string): boolean {
      return db.prepare('UPDATE passkey_challenges SET used_at = ? WHERE challenge = ? AND used_at IS NULL').run(at, challenge).changes === 1;
    },
  };
}
