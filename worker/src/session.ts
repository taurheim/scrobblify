/**
 * Client sessions.
 *
 * **A bearer token, not a cookie — a deliberate deviation from the spec.**
 *
 * The spec proposed a `__Host-` cookie plus CSRF tokens. That was written
 * assuming the API and the SPA share an origin. They do not: the SPA is served
 * from `savas.ca` and this worker answers on `api.savas.ca`, which is
 * cross-site for cookie purposes. A cookie would therefore need
 * `SameSite=None`, i.e. it would be attached to *every* cross-site request any
 * page in the world makes to this API — ambient authority, and the exact
 * condition CSRF needs. The `__Host-` prefix would buy nothing here, which the
 * spec's own second review already noted.
 *
 * A bearer token held by the SPA and sent in an `Authorization` header has no
 * ambient authority, so CSRF is structurally impossible rather than defended
 * against. It costs the same CORS configuration either way.
 *
 * What it does *not* fix: the token lives in `savas.ca` storage, which
 * LastWave shares. That is the trust boundary already accepted for the beta,
 * and no cookie scheme would have isolated it either.
 */
import { signPayload, verifyPayload, normalizeUsername } from './crypto';

/**
 * Sessions are short by web standards because they authorise reading a
 * complete listening history and cancelling a month of work. Re-authenticating
 * costs a redirect the user has already agreed to once.
 */
export const SESSION_TTL_SECONDS = 14 * 86400;

export interface SessionClaims {
  /** Normalised Last.fm username. */
  u: string;
  /** Issued at, unix seconds. */
  iat: number;
  /** Expiry, unix seconds. */
  exp: number;
}

export async function issueSession(
  username: string,
  signingKey: string,
  nowSec: number,
): Promise<string> {
  return signPayload(
    { u: normalizeUsername(username), iat: nowSec, exp: nowSec + SESSION_TTL_SECONDS },
    signingKey,
  );
}

/**
 * Returns the username a request is authenticated as, or null.
 *
 * Deliberately returns only the username, not a job id. Binding a session to a
 * job at issue time would let a stale token address a job the user has since
 * replaced; resolving the job from the username on every request means
 * authorisation is always evaluated against current state.
 */
export async function authenticate(
  request: Request,
  signingKey: string,
  nowSec: number,
): Promise<string | null> {
  const header = request.headers.get('Authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  const claims = await verifyPayload<SessionClaims>(header.slice(7).trim(), signingKey);
  if (!claims || typeof claims.u !== 'string' || typeof claims.exp !== 'number') {
    return null;
  }
  if (claims.exp <= nowSec) {
    return null;
  }
  return claims.u;
}
