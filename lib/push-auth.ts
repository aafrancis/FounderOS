/**
 * Auth for the three push endpoints other machines call (FounderOS merge):
 *
 *   POST /api/trading/snapshot   TRADING_PUSH_TOKEN   (the Markets agent)
 *   POST /api/usage/push         USAGE_PUSH_TOKEN     (another machine's usage reader)
 *   POST /api/plaud/ingest       PLAUD_INGEST_TOKEN   (Plaud webhook / relay)
 *   /api/approvals/hard-line     HARDLINE_REQUEST_TOKEN (agents file and poll hard-line
 *                                requests; approving needs the founder's passkey, SH-0277)
 *
 * A pushing machine cannot hold the operator's session cookie, so the
 * middleware lets exactly these paths through (lib/auth-gate.ts TOKEN_PATHS)
 * and this check runs in the route instead. It fails closed:
 *
 *   1. `Authorization: Bearer <token>` (or `x-glados-token`) equal to the
 *      configured token → allowed. Compared in constant time.
 *   2. otherwise the request is judged exactly like any other API call: with a
 *      password set it needs the session cookie; with none it must come from
 *      loopback. Cross-origin writes are refused either way.
 *
 * So an unset token never means "open": it means "operator session only".
 */
import { SESSION_COOKIE, hostnameOf, isLoopbackHost } from '@/lib/auth-gate';
import { cookieFromHeader, readAuthState, sameSecret } from '@/lib/auth';
import { resolveCred } from '@/lib/creds';

export type PushTokenKey = 'TRADING_PUSH_TOKEN' | 'USAGE_PUSH_TOKEN' | 'PLAUD_INGEST_TOKEN' | 'HARDLINE_REQUEST_TOKEN';

export type PushAuth = { ok: true; via: 'token' | 'session' } | { ok: false; status: 401 | 403; error: string };

function presentedToken(req: Request): string | null {
  const auth = req.headers.get('authorization') ?? '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const alt = req.headers.get('x-glados-token');
  return alt ? alt.trim() : null;
}

export function pushTokenConfigured(key: PushTokenKey): boolean {
  return Boolean(resolveCred(key, [])?.trim());
}

export function authorizePush(req: Request, key: PushTokenKey): PushAuth {
  const presented = presentedToken(req);
  const expected = resolveCred(key, [])?.trim();
  if (presented) {
    if (expected && sameSecret(presented, expected)) return { ok: true, via: 'token' };
    return { ok: false, status: 401, error: 'push token rejected' };
  }

  // No token: the operator's own browser or a loopback script, judged like the middleware would.
  const origin = req.headers.get('origin');
  const host = req.headers.get('host') ?? new URL(req.url).host;
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = '';
    }
    if (originHost !== host) return { ok: false, status: 403, error: 'cross-origin push refused' };
  }
  const state = readAuthState();
  if (state.configured) {
    const cookie = cookieFromHeader(req.headers.get('cookie'), SESSION_COOKIE);
    if (cookie && state.sessionSecret && sameSecret(cookie, state.sessionSecret)) return { ok: true, via: 'session' };
    return { ok: false, status: 401, error: `send Authorization: Bearer <${key}>` };
  }
  if (isLoopbackHost(hostnameOf(host))) return { ok: true, via: 'session' };
  return { ok: false, status: 401, error: `send Authorization: Bearer <${key}>` };
}
