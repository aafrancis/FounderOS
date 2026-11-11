/**
 * A software WebAuthn authenticator for tests (SH-0277). Makes real P-256
 * keys and real ES256 signatures over real authenticatorData and
 * clientDataJSON, so @simplewebauthn/server verifies them exactly as it would
 * a phone's. Like Apple passkeys, it reports a signature counter of 0.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Uint8Array | CborMap | { [k: string]: Cbor };
interface CborMap extends Map<Cbor, Cbor> {}

function head(major: number, n: number): Buffer {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  const b = Buffer.alloc(5);
  b[0] = (major << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
}

/** Just enough CBOR for COSE keys and a "none" attestation object. */
export function cbor(v: Cbor): Buffer {
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') {
    const b = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v);
  return Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, val]) => [cbor(k), cbor(val)])]);
}

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest();
const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

export type SoftKey = { id: string; privateKey: KeyObject; cose: Buffer };

export function newKey(): SoftKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
  const cose = cbor(new Map<Cbor, Cbor>([
    [1, 2], // kty: EC2
    [3, -7], // alg: ES256
    [-1, 1], // crv: P-256
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]));
  return { id: b64u(randomBytes(16)), privateKey, cose };
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

function clientData(type: string, challenge: string, origin: string): string {
  return b64u(Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
}

/** navigator.credentials.create() output, as @simplewebauthn/browser would send it. */
export function attest(key: SoftKey, o: { challenge: string; rpID: string; origin: string; uv?: boolean }) {
  const credId = Buffer.from(key.id, 'base64url');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(credId.length);
  const authData = Buffer.concat([
    sha256(o.rpID),
    Buffer.from([UP | (o.uv === false ? 0 : UV) | AT]),
    Buffer.alloc(4), // counter 0
    Buffer.alloc(16), // aaguid
    len,
    credId,
    key.cose,
  ]);
  const attestationObject = cbor({ fmt: 'none', attStmt: {}, authData });
  return {
    id: key.id,
    rawId: key.id,
    type: 'public-key' as const,
    clientExtensionResults: {},
    response: { clientDataJSON: clientData('webauthn.create', o.challenge, o.origin), attestationObject: b64u(attestationObject), transports: ['internal' as const] },
  };
}

/** navigator.credentials.get() output: a signed assertion over `challenge`. */
export function assert(key: SoftKey, o: { challenge: string; rpID: string; origin: string; uv?: boolean; asId?: string }) {
  const authData = Buffer.concat([sha256(o.rpID), Buffer.from([UP | (o.uv === false ? 0 : UV)]), Buffer.alloc(4)]);
  const cdj = clientData('webauthn.get', o.challenge, o.origin);
  const signature = sign('sha256', Buffer.concat([authData, sha256(Buffer.from(cdj, 'base64url'))]), key.privateKey);
  const id = o.asId ?? key.id;
  return {
    id,
    rawId: id,
    type: 'public-key' as const,
    clientExtensionResults: {},
    response: { clientDataJSON: cdj, authenticatorData: b64u(authData), signature: b64u(signature) },
  };
}
