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
 *   reconnect the user asked to sign in from Home ("Re-connect to last.fm")
 */
export type SignInIntent =
  | { kind: 'send'; importId: string; checkDuplicates: boolean }
  | { kind: 'resume' }
  | { kind: 'reconnect' };

const KEY = 'scrobblify.signInIntent';

function parseIntent(raw: string | null): SignInIntent | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.kind === 'resume' || parsed.kind === 'reconnect')) {
      return { kind: parsed.kind };
    }
    if (parsed && parsed.kind === 'send' && typeof parsed.importId === 'string') {
      return { kind: 'send', importId: parsed.importId, checkDuplicates: parsed.checkDuplicates === true };
    }
  } catch {
    // Not ours, or damaged: no intent.
  }
  return null;
}

/** Reads and forgets the intent, so it is acted on once. */
export function takeSignInIntent(): SignInIntent | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return parseIntent(raw);
  } catch {
    return null;
  }
}

/** Reads the intent without forgetting it. */
export function peekSignInIntent(): SignInIntent | null {
  try {
    return parseIntent(sessionStorage.getItem(KEY));
  } catch {
    return null;
  }
}

/** Records the intent without leaving: the page it is acted on is reached in-app. */
export function setSignInIntent(intent: SignInIntent): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // Private modes can refuse storage. The page just won't carry on by itself.
  }
}

/** Records the intent and leaves for Last.fm. */
export function startSignIn(api: LastFm, intent: SignInIntent): void {
  setSignInIntent(intent);
  trackEvent('sign_in_started', { intent: intent.kind });
  window.location.href = api.getAuthorizeUrl();
}
