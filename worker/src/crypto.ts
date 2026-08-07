/**
 * Cryptography: handoff state signing and credential encryption at rest.
 *
 * WebCrypto only — it exists in both Workers and Node 18+, so the worker stays
 * portable to a plain VM (spec "Portability requirements"). Note that Last.fm's
 * own request signing needs MD5, which WebCrypto deliberately does not
 * implement; that lives in the shared protocol module and uses a pure-JS hash.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Constant-time comparison.
 *
 * A byte-by-byte early return leaks how much of a signature was correct, which
 * is enough to forge one a byte at a time. The length check is not
 * timing-safe, but length is not the secret.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    // eslint-disable-next-line no-bitwise
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export interface HandoffState {
  /** Handoff row id. */
  h: string;
  /** Expiry, unix seconds. */
  exp: number;
}

/**
 * Signs the opaque `state` value carried through the Last.fm redirect.
 *
 * This must be produced by the *worker*, not the client: the whole point is
 * that at callback time the worker can verify something it committed before the
 * redirect. A nonce or digest that originates in the browser proves nothing,
 * since anything the browser can compute an attacker can compute too.
 *
 * The state is not a bearer credential on its own — it identifies a handoff
 * whose row also records the expected username, and `auth.getSession` must
 * agree with that username before any data is written.
 */
export async function signHandoffState(
  payload: HandoffState,
  signingKey: string,
): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify(payload)));
  const key = await hmacKey(signingKey);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

/**
 * Verifies and decodes a state value.
 *
 * Returns null for anything malformed, unsigned, wrongly signed or expired.
 * Callers must treat null as "reject the callback entirely" — never as "carry
 * on without state".
 */
export async function verifyHandoffState(
  value: string,
  signingKey: string,
  nowSec: number,
): Promise<HandoffState | null> {
  const dot = value.indexOf('.');
  if (dot <= 0 || dot === value.length - 1) {
    return null;
  }
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);

  let provided: Uint8Array;
  try {
    provided = fromBase64Url(sig);
  } catch {
    return null;
  }

  const key = await hmacKey(signingKey);
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, enc.encode(body)),
  );
  if (!timingSafeEqual(provided, expected)) {
    return null;
  }

  let parsed: HandoffState;
  try {
    parsed = JSON.parse(dec.decode(fromBase64Url(body)));
  } catch {
    return null;
  }
  if (typeof parsed.h !== 'string' || typeof parsed.exp !== 'number') {
    return null;
  }
  if (parsed.exp <= nowSec) {
    return null;
  }
  return parsed;
}

/**
 * Derives the AES key used to encrypt session keys at rest.
 *
 * The key material lives in a Worker secret, never in D1 beside the ciphertext,
 * so a database leak alone does not yield write access to users' Last.fm
 * accounts.
 *
 * This is a plain SHA-256 of the secret rather than a KDF with a salt because
 * the secret is already high-entropy random material, not a password. Note that
 * this means the encryption key cannot be rotated without stranding every job's
 * credential.
 */
async function credentialKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', material, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
}

/**
 * `aad` binds the ciphertext to the job that owns it, so a credential row
 * copied to a different job fails to decrypt rather than silently scrobbling
 * one user's tracks with another user's key.
 */
export async function encryptCredential(
  plaintext: string,
  secret: string,
  aad: string,
): Promise<EncryptedCredential> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await credentialKey(secret);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
    key,
    enc.encode(plaintext),
  );
  return { ciphertext: toBase64Url(new Uint8Array(ct)), iv: toBase64Url(iv) };
}

/** Returns null rather than throwing on tampering, so callers must handle it. */
export async function decryptCredential(
  encrypted: EncryptedCredential,
  secret: string,
  aad: string,
): Promise<string | null> {
  try {
    const key = await credentialKey(secret);
    const pt = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64Url(encrypted.iv),
        additionalData: enc.encode(aad),
      },
      key,
      fromBase64Url(encrypted.ciphertext),
    );
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** Unguessable identifier for handoff and job rows. */
export function randomId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/**
 * Last.fm usernames are compared for equality in the one place that decides
 * whose account gets written to, so normalise deliberately and narrowly: case
 * folding only, no trimming of internal characters, no Unicode folding that
 * could map two distinct accounts onto one.
 */
export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}
