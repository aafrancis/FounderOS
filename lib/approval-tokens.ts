/**
 * Proposing tokens for agents (SH-0271). An agent such as a Wild Horse loop
 * cannot hold the operator's session cookie, so it files proposals with a
 * bearer token instead. A token can ONLY propose, and only on the channels it
 * was issued for. It cannot approve, reject, run, arm, disarm, kill or issue
 * anything: those stay with the operator session (and the arming secret).
 *
 * Only a SHA-256 hash of a token is stored. Tokens are 256 random bits, so a
 * plain fast hash is enough (there is nothing to brute-force); the plain token
 * is shown once, when it is issued.
 */
import { createHash, randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'apt_';
const MAX_PRESENTED = 200;

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The bearer token on a request, or null. Anything not shaped like ours is dropped before any lookup. */
export function bearerOf(req: Request): string | null {
  const m = (req.headers.get('authorization') ?? '').match(/^Bearer\s+(\S+)$/i);
  const t = m?.[1] ?? null;
  return t && t.startsWith(TOKEN_PREFIX) && t.length <= MAX_PRESENTED ? t : null;
}
