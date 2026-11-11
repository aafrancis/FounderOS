/**
 * The gate's decision table. Pure and edge-safe (no node: imports) so the
 * middleware can run it and the tests can cover every branch without a server.
 *
 * Model:
 *   - no password set   → open on this machine only (loopback Host); any other
 *                         Host is refused with 503 until a password exists.
 *   - password set      → every page and API route needs the session cookie.
 *   - always            → mutating cross-origin requests are refused (CSRF).
 *
 * The loopback rule is judged on the Host header, which a remote client can
 * forge. That is why `scripts/serve.mjs` refuses to bind to anything but
 * 127.0.0.1 while no password exists: the network never reaches this code in
 * that state. The Host check is the second layer, for `next dev` run by hand.
 */

export const SESSION_COOKIE = 'glados_session';

/** Reachable without a session: the login page + endpoint, the status probe the
 *  middleware itself calls, and webhooks (which carry their own shared secret). */
export const OPEN_PATHS = ['/login', '/api/auth/login', '/api/auth/check'] as const;

/** Push endpoints another machine calls with a bearer token instead of a session
 *  (FounderOS merge). Exact paths only. Each route runs lib/push-auth.ts, which
 *  fails closed: no valid token means the same session/loopback rule as here.
 *  /api/trading/limits: GET with the token (the Markets agent reads its limits);
 *  PATCH refuses the token and takes the operator session only. */
export const TOKEN_PATHS = [
  '/api/trading/snapshot', '/api/trading/limits', '/api/usage/push', '/api/plaud/ingest',
  // SH-0277: agents file and poll hard-line requests. File and read only; approving needs the founder's passkey.
  '/api/approvals/hard-line',
] as const;

export function isOpenPath(pathname: string): boolean {
  return (
    (OPEN_PATHS as readonly string[]).includes(pathname) ||
    (TOKEN_PATHS as readonly string[]).includes(pathname) ||
    pathname.startsWith('/api/webhooks/')
  );
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  );
}

/**
 * Hostname out of a Host header ("localhost:4100" → "localhost",
 * "[::1]:4100" → "::1"). Self-hosted Next reports its *internal* host on
 * req.nextUrl, so the gate must read the header the browser actually sent.
 */
export function hostnameOf(hostHeader: string | null | undefined): string {
  const h = (hostHeader ?? '').trim();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h;
  }
  const colon = h.lastIndexOf(':');
  // a bare IPv6 literal without brackets has several colons; leave it whole
  return colon > 0 && h.indexOf(':') === colon ? h.slice(0, colon) : h;
}

/** The origin the browser believes it is talking to, from the headers a
 *  reverse proxy forwards (or the plain Host header when there is none). */
export function requestOriginOf(headers: { get(name: string): string | null }): { hostname: string; origin: string } {
  const host = headers.get('x-forwarded-host') ?? headers.get('host') ?? '';
  const proto = headers.get('x-forwarded-proto') ?? 'http';
  return { hostname: hostnameOf(host), origin: `${proto}://${host}` };
}

/**
 * Names to treat as this machine, from GLADOS_TRUSTED_HOSTS (comma separated).
 *
 * Only consulted while NO password is set, and only to decide "is this request
 * coming from the machine itself". It exists so a filming alias like
 * glados.com, pointed at 127.0.0.1 in /etc/hosts, does not hit the
 * unconfigured-remote 503. Once a password IS set this list is ignored
 * entirely and every host goes through login as before.
 *
 * Only ever put names here that resolve to this machine.
 */
export function parseTrustedHosts(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export type GateInput = {
  pathname: string;
  method: string;
  /** Host the browser asked for (req.nextUrl.hostname). */
  hostname: string;
  /** Origin header of the request, null when the browser sent none. */
  origin: string | null;
  /** The origin this server believes it is (req.nextUrl.origin). */
  requestOrigin: string;
  configured: boolean;
  authed: boolean;
  /** See parseTrustedHosts. Empty unless GLADOS_TRUSTED_HOSTS is set. */
  trustedHosts?: readonly string[];
};

export type GateDecision =
  | { kind: 'pass' }
  | { kind: 'cross-origin' }
  | { kind: 'unauthorized-api' }
  | { kind: 'redirect-login' }
  | { kind: 'unconfigured-remote' };

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function decideGate(i: GateInput): GateDecision {
  if (isOpenPath(i.pathname)) return { kind: 'pass' };

  const mutating = !SAFE_METHODS.has(i.method.toUpperCase());
  const crossOrigin = mutating && i.origin !== null && i.origin !== i.requestOrigin;

  if (!i.configured) {
    const host = i.hostname.trim().toLowerCase();
    const local = isLoopbackHost(host) || (i.trustedHosts ?? []).includes(host);
    if (!local) return { kind: 'unconfigured-remote' };
    return crossOrigin ? { kind: 'cross-origin' } : { kind: 'pass' };
  }

  if (i.authed) return crossOrigin ? { kind: 'cross-origin' } : { kind: 'pass' };

  return i.pathname.startsWith('/api/') ? { kind: 'unauthorized-api' } : { kind: 'redirect-login' };
}

export const UNCONFIGURED_REMOTE_MESSAGE =
  'This console has no operator password yet, so it only answers on the machine it runs on. ' +
  'Open it there (http://localhost:<port>/setup) and set a password under Security, then come back.';
