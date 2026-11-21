import LastFm from '@/api/LastFm';
import { trackEvent } from '@/services/Analytics';

/**
 * Why this browser went to Last.fm, so the page it comes back to can carry on.
 *
 * Kept in sessionStorage: Last.fm sends the user back in the same tab, and
 * nothing in memory survives that round trip.
 *
 *   send      a selection made while signed out, saved to IndexedDB as
 *             `importId`, is waiting to be sent
 *   resume    saved progress should resume once signed in
 *   reconnect the user asked to sign in (Home's "Re-connect to last.fm", or
 *             the sign-in banner after a refused progress file)
 */
export type SignInPurpose =
  | { kind: 'send'; importId: string; checkDuplicates: boolean }
  | { kind: 'resume' }
  | { kind: 'reconnect' };

/**
 * A recorded purpose. `inApp` says how the page acting on it is reached:
 * in-app (`setSignInIntent`, already signed in) or back from Last.fm
 * (`startSignIn`). `createdAt` (ms) lets an abandoned one expire.
 */
export type SignInIntent = SignInPurpose & { inApp: boolean; createdAt: number };

const KEY = 'scrobblify.signInIntent';

/** Last.fm's authorize tokens last about an hour; an older intent was abandoned. */
export const SIGN_IN_INTENT_MAX_AGE_MS = 60 * 60 * 1000;

function parseIntent(raw: string | null): SignInIntent | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const meta = {
      inApp: parsed.inApp === true,
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : NaN,
    };
    if (parsed.kind === 'resume' || parsed.kind === 'reconnect') {
      return { kind: parsed.kind, ...meta };
    }
    if (parsed.kind === 'send' && typeof parsed.importId === 'string') {
      return {
        kind: 'send', importId: parsed.importId, checkDuplicates: parsed.checkDuplicates === true, ...meta,
      };
    }
  } catch {
    // Not ours, or damaged: no intent.
  }
  return null;
}

/**
 * Whether a sign-in that just completed is the one the intent was recorded
 * for. `fresh` is AuthenticateStep's: this load arrived with a callback
 * `?token=`. A Last.fm intent needs a return from Last.fm, and an in-app one
 * a page reached without one, so an abandoned trip to Last.fm is never acted on
 * by a later visit that merely finds a stored session. Expired intents
 * (or ones without a time) are ignored either way.
 */
function appliesTo(intent: SignInIntent, fresh: boolean): boolean {
  const age = Date.now() - intent.createdAt;
  if (!Number.isFinite(age) || Math.abs(age) > SIGN_IN_INTENT_MAX_AGE_MS) {
    return false;
  }
  return fresh !== intent.inApp;
}

/**
 * Reads and forgets the intent, so it is acted on once. Returns null, but
 * still forgets it, when it isn't for this sign-in (see `appliesTo`).
 */
export function takeSignInIntent(fresh: boolean): SignInIntent | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    const intent = parseIntent(raw);
    return intent && appliesTo(intent, fresh) ? intent : null;
  } catch {
    return null;
  }
}

/** Reads the intent without forgetting it; null unless it is for this sign-in. */
export function peekSignInIntent(fresh: boolean): SignInIntent | null {
  try {
    const intent = parseIntent(sessionStorage.getItem(KEY));
    return intent && appliesTo(intent, fresh) ? intent : null;
  } catch {
    return null;
  }
}

function writeIntent(purpose: SignInPurpose, inApp: boolean): void {
  try {
    const intent: SignInIntent = { ...purpose, inApp, createdAt: Date.now() };
    sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // Private modes can refuse storage. The page just won't carry on by itself.
  }
}

/**
 * Records the intent without leaving, for a user who is already signed in: the
 * page it is acted on is reached in-app, and acts on it only then.
 */
export function setSignInIntent(purpose: SignInPurpose): void {
  writeIntent(purpose, true);
}

/** Records the intent and leaves for Last.fm; acted on only on the way back. */
export function startSignIn(api: LastFm, purpose: SignInPurpose): void {
  writeIntent(purpose, false);
  trackEvent('sign_in_started', { intent: purpose.kind });
  window.location.href = api.getAuthorizeUrl();
}
