/**
 * Last.fm wire protocol, shared by the browser SPA and the background worker.
 *
 * Both runtimes must agree exactly on how requests are signed and how
 * responses are interpreted, so this module is deliberately free of anything
 * environment-specific: no DOM, no Node built-ins, no `@/` path aliases (the
 * worker's bundler cannot resolve them). It is pure functions over plain data.
 *
 * Reference: https://www.last.fm/api/show/track.scrobble
 */
import md5 from 'blueimp-md5';

/** Last.fm accepts up to 50 scrobbles in a single track.scrobble call. */
export const MAX_SCROBBLES_PER_BATCH = 50;

/** Scrobbles older than this are rejected with ignore code 3. */
export const SCROBBLE_WINDOW_DAYS = 14;

/**
 * `ignoredMessage.code` on a per-scrobble entry. A 200 response does not mean
 * the play was stored — every entry carries one of these.
 *
 * Deliberately a plain object rather than a TS enum: Last.fm can introduce
 * codes we have never seen, and outcomes carry a raw `number` so an unknown
 * code survives round-tripping instead of being coerced to a known one.
 */
export const IgnoreCode = {
  Accepted: 0,
  ArtistIgnored: 1,
  TrackIgnored: 2,
  TimestampTooOld: 3,
  TimestampTooNew: 4,
  DailyLimitReached: 5,
} as const;

/** Top-level `error` codes. https://www.last.fm/api/errorcodes */
export const ApiErrorCode = {
  InvalidToken: 4,
  InvalidSessionKey: 9,
  TokenNotAuthorized: 14,
  TokenExpired: 15,
  SuspendedApiKey: 26,
  RateLimitExceeded: 29,
} as const;

export interface ScrobbleEntry {
  artist: string;
  track: string;
  album?: string;
  /** Unix seconds. Must fall inside the 14-day window *at send time*. */
  timestampSec: number;
}

export interface CorrectedNames {
  artist?: string;
  track?: string;
  album?: string;
}

export interface ScrobbleOutcome {
  /** Position within the submitted batch. */
  index: number;
  accepted: boolean;
  /** Raw Last.fm code; compare against `IgnoreCode`, but do not assume it is one. */
  ignoredCode: number;
  ignoredMessage: string;
  /**
   * Last.fm normalises artist/track/album names and flags what it changed.
   * Reconciliation must compare against these, not against what we sent, or it
   * will fail to recognise its own writes.
   */
  corrected?: CorrectedNames;
}

export interface BatchScrobbleResult {
  accepted: number;
  ignored: number;
  outcomes: ScrobbleOutcome[];
}

/**
 * True when Last.fm will never accept this scrobble, no matter how often it is
 * retried — the caller should record it as failed and move on.
 */
export function isPermanentIgnore(code: number): boolean {
  return code === IgnoreCode.ArtistIgnored || code === IgnoreCode.TrackIgnored;
}

/**
 * True when the entry was rejected for a reason we can fix and retry: the
 * daily allowance resets, and a bad timestamp means *our* assignment was wrong
 * rather than the track being unscrobbleable.
 */
export function isRetryableIgnore(code: number): boolean {
  return code === IgnoreCode.DailyLimitReached
    || code === IgnoreCode.TimestampTooOld
    || code === IgnoreCode.TimestampTooNew;
}

/** https://www.last.fm/api/show/track.scrobble — ignoredMessage codes. */
export function describeIgnoreCode(code: number, message: string): string {
  const known: {[key: number]: string} = {
    [IgnoreCode.ArtistIgnored]: 'Last.fm ignored this artist',
    [IgnoreCode.TrackIgnored]: 'Last.fm ignored this track',
    [IgnoreCode.TimestampTooOld]: 'Timestamp was too far in the past (Last.fm only accepts the last 14 days)',
    [IgnoreCode.TimestampTooNew]: 'Timestamp was in the future',
    [IgnoreCode.DailyLimitReached]: 'Daily scrobble limit reached',
  };
  return known[code] || message || `Last.fm ignored this scrobble (code ${code})`;
}

/**
 * Builds the `track.scrobble` parameters for a batch.
 *
 * Array notation is `artist[i]`, `track[i]`, `timestamp[i]`, `album[i]`, with
 * `i` contiguous from 0.
 */
export function buildScrobbleParams(entries: ScrobbleEntry[]): {[key: string]: string} {
  if (entries.length === 0) {
    throw new Error('buildScrobbleParams: no entries');
  }
  if (entries.length > MAX_SCROBBLES_PER_BATCH) {
    throw new Error(
      `buildScrobbleParams: ${entries.length} entries exceeds Last.fm's limit of ${MAX_SCROBBLES_PER_BATCH}`,
    );
  }
  const params: {[key: string]: string} = { method: 'track.scrobble' };
  entries.forEach((entry, i) => {
    params[`artist[${i}]`] = entry.artist;
    params[`track[${i}]`] = entry.track;
    params[`timestamp[${i}]`] = String(entry.timestampSec);
    // Omit rather than send empty: Last.fm treats a blank album as a real value
    // and it participates in the signature.
    if (entry.album) {
      params[`album[${i}]`] = entry.album;
    }
  });
  return params;
}

/**
 * Signs a parameter set. https://www.last.fm/api/webauth
 *
 * Last.fm requires parameters ordered by the ASCII table, which means
 * `artist[10]` sorts *before* `artist[1]` (`]` is 0x5D, `0` is 0x30).
 * JavaScript's default `Array.sort()` compares UTF-16 code units and already
 * produces exactly that order, so it must be left alone — "fixing" this into a
 * natural/numeric sort produces signatures Last.fm rejects with error 13.
 */
export function signParams(params: {[key: string]: any}, sharedSecret: string): string {
  const keys = Object.keys(params).sort();
  let acc = '';
  keys.forEach((key) => {
    acc += `${key}${params[key]}`;
  });
  return md5(acc + sharedSecret);
}

export function encodeParams(params: {[key: string]: string}): string {
  return Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');
}

function readCorrected(node: any): string | undefined {
  if (!node || typeof node !== 'object') {
    return undefined;
  }
  return node.corrected === '1' || node.corrected === 1 ? node['#text'] : undefined;
}

/**
 * Parses a `track.scrobble` response into one outcome per submitted entry.
 *
 * Last.fm returns `scrobble` as a bare object for a single scrobble and as an
 * array for a batch, so both shapes are normalised here.
 *
 * `expectedCount` matters: if the response is unparseable or truncated we must
 * still return one outcome per entry, because the caller advances its cursor
 * over this array. Missing entries default to *accepted* for the same reason
 * the single-track parser always has — an unrecognised response must never
 * turn a working scrobble into a reported failure.
 */
export function parseScrobbleResponse(response: any, expectedCount: number): BatchScrobbleResult {
  const scrobbles = (response && response.scrobbles) || {};
  const attr = scrobbles['@attr'] || {};

  let entries = scrobbles.scrobble;
  if (entries && !Array.isArray(entries)) {
    entries = [entries];
  }
  if (!Array.isArray(entries)) {
    entries = [];
  }

  const outcomes: ScrobbleOutcome[] = [];
  for (let i = 0; i < expectedCount; i += 1) {
    const entry = entries[i];
    const ignored = (entry && entry.ignoredMessage) || {};
    const rawCode = Number(ignored.code);
    const code = Number.isFinite(rawCode) ? rawCode : IgnoreCode.Accepted;

    const corrected: CorrectedNames = {
      artist: readCorrected(entry && entry.artist),
      track: readCorrected(entry && entry.track),
      album: readCorrected(entry && entry.album),
    };
    const hasCorrection = Boolean(corrected.artist || corrected.track || corrected.album);

    const outcome: ScrobbleOutcome = {
      index: i,
      accepted: code === IgnoreCode.Accepted,
      ignoredCode: code,
      ignoredMessage: ignored['#text'] || '',
    };
    if (hasCorrection) {
      outcome.corrected = corrected;
    }
    outcomes.push(outcome);
  }

  // Prefer the counts derived per entry: @attr is only a summary and cannot say
  // *which* entries failed, which is what the caller actually needs. Fall back
  // to @attr only when the response carried no entries at all.
  const acceptedCount = outcomes.filter((outcome) => outcome.accepted).length;
  const attrAccepted = Number(attr.accepted);
  const attrIgnored = Number(attr.ignored);
  const haveEntries = entries.length > 0;

  return {
    accepted: haveEntries || !Number.isFinite(attrAccepted) ? acceptedCount : attrAccepted,
    ignored: haveEntries || !Number.isFinite(attrIgnored)
      ? outcomes.length - acceptedCount
      : attrIgnored,
    outcomes,
  };
}

const SENSITIVE_PARAMS = new Set(['api_key', 'api_sig', 'sk', 'token']);

/**
 * Credentials must never reach logs or analytics. An early version of this app
 * leaked a user's Last.fm session key into error reporting; do not widen what
 * this returns.
 */
export function sanitizeRequestParams(params: {[key: string]: string}): {[key: string]: string} {
  return Object.keys(params).reduce((acc, key) => {
    acc[key] = SENSITIVE_PARAMS.has(key) ? '[redacted]' : params[key];
    return acc;
  }, {} as {[key: string]: string});
}

/**
 * Normalised so identical failures group together in error reporting rather
 * than fragmenting on per-request detail.
 */
export function buildLastFmErrorMessage(
  httpStatus: number,
  errorCode: number | string,
  errorMessage: string,
  params: {[key: string]: string},
): string {
  const safeParams = sanitizeRequestParams(params);
  const statusPart = httpStatus ? ` (HTTP ${httpStatus})` : '';
  return `Last.fm API error ${errorCode}${statusPart}: ${errorMessage}. Request: ${JSON.stringify(safeParams)}`;
}

export function isLastFmApiError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('Last.fm API error');
}

function hasErrorCode(error: unknown, codes: number[]): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return new RegExp(`^Last\\.fm API error (${codes.join('|')})\\b`).test(error.message);
}

/**
 * Error 29 is documented as "Your IP has made too many requests in a short
 * period" — an *IP-level* limit, shared across every caller behind that
 * address. It is not the per-user daily scrobble cap, which arrives instead as
 * ignore code 5 on an HTTP 200. Conflating the two is why per-session counters
 * never predicted throttling.
 */
export function isRateLimitError(error: unknown): boolean {
  return hasErrorCode(error, [ApiErrorCode.RateLimitExceeded]);
}

/**
 * The session key has been revoked by the user. It can never be revived, so
 * the only recovery is re-authorisation — never retry.
 */
export function isInvalidSessionKeyError(error: unknown): boolean {
  return hasErrorCode(error, [ApiErrorCode.InvalidSessionKey]);
}

/** The API key itself is suspended; every caller using it is dead until fixed. */
export function isSuspendedApiKeyError(error: unknown): boolean {
  return hasErrorCode(error, [ApiErrorCode.SuspendedApiKey]);
}

/**
 * Auth-token errors from auth.getSession. All mean the token can never be
 * exchanged again, so recovery is a fresh trip through the authorize flow:
 *   4  = invalid/unissued (already consumed by a link scanner, prefetch, or
 *        an earlier tab)
 *   14 = not authorized by the user
 *   15 = expired (tokens last ~60 minutes)
 */
export function isAuthTokenError(error: unknown): boolean {
  return hasErrorCode(error, [
    ApiErrorCode.InvalidToken,
    ApiErrorCode.TokenNotAuthorized,
    ApiErrorCode.TokenExpired,
  ]);
}

/**
 * A failed `fetch` (offline, DNS failure, connection reset, CORS, ad-blocker)
 * rejects with a TypeError rather than an HTTP response. These are transient
 * connectivity problems, not a problem with a specific track, so callers should
 * pause and retry rather than mark the track failed.
 *
 * The message differs per runtime: "Failed to fetch" (Chrome/Edge/Workers),
 * "NetworkError when attempting to fetch resource." (Firefox), "Load failed"
 * (Safari).
 */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error instanceof TypeError) {
    return true;
  }
  return /failed to fetch|networkerror|network request failed|load failed/i.test(error.message);
}
