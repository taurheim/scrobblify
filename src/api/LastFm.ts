import Scrobble from '@/models/Scrobble';
import md5 from 'blueimp-md5';

/** Outcome of a single track.scrobble call, as reported by Last.fm itself. */
export interface ScrobbleResult {
  accepted: number;
  ignored: number;
  /** 0 when accepted. See LastFm.describeIgnoreCode for the rest. */
  ignoredCode: number;
  ignoredMessage: string;
}

export default class LastFm {
  private API_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

  private API_RATE_BUFFER_MS = 250;

  // Track durations are immutable, but a Spotify export is mostly *repeat*
  // plays — the whole point of the app. Looking a track up once per play rather
  // than once per distinct track multiplied every validation run by the user's
  // average play count, at 250ms of enforced rate buffer each.
  private trackDurationCache = new Map<string, number>();

  // NOTE: Last.fm auth tokens are single-use (consumed by auth.getSession), so
  // we deliberately do not persist them. Only the resulting session key is stored.
  private USER_AUTH_TOKEN_LOCALSTORAGE_KEY_LEGACY = 'scrobblifyLfmAuthToken';

  private USER_AUTH_KEY_LOCALSTORAGE_KEY = 'scrobblifyLfmAuthKey';

  private USER_NAME_LOCALSTORAGE_KEY = 'scrobblifyLfmUserName';

  // Records the single-use auth token we've already begun exchanging so that a
  // reload / component re-mount / duplicate load during the in-flight
  // auth.getSession call never re-submits the same token. Kept in
  // sessionStorage (per-tab, cleared when the tab closes) because a token only
  // needs to be exchanged once within a single browsing session.
  private ATTEMPTED_AUTH_TOKEN_SESSIONSTORAGE_KEY = 'scrobblifyLfmAttemptedAuthToken';

  private userAuthKey: string | null = null;

  private userAuthToken: string | null = null;

  private userName: string | null = null;

  constructor(
    private lfmApiKey: string,
    private lfmSharedSecret: string,
  ) {
  }

  public async init(queryParams: any) {
    // Clean up any legacy persisted auth token from older versions; tokens are single-use.
    localStorage.removeItem(this.USER_AUTH_TOKEN_LOCALSTORAGE_KEY_LEGACY);

    this.setUserAuthKey(localStorage.getItem(this.USER_AUTH_KEY_LOCALSTORAGE_KEY));
    this.setUserName(localStorage.getItem(this.USER_NAME_LOCALSTORAGE_KEY));
    // Auth token is single-use and only valid for ~60 minutes; always take the
    // fresh value from the URL query (returned by Last.fm's auth callback).
    this.userAuthToken = queryParams.token || null;

    if (!this.isAuthenticated() && this.userAuthToken) {
      // Guard against exchanging the same single-use token twice. Last.fm
      // consumes the token on auth.getSession and rejects any re-use with
      // error 4 "Unauthorized Token - This token has not been issued". A reload
      // or component re-mount while the first exchange is still in flight (slow
      // network, impatient refresh, browser restoring the callback URL, etc.)
      // would otherwise re-submit the already-consumed token. Marking the token
      // *before* the network call closes that window.
      if (sessionStorage.getItem(this.ATTEMPTED_AUTH_TOKEN_SESSIONSTORAGE_KEY) === this.userAuthToken) {
        this.userAuthToken = null;
        return;
      }
      sessionStorage.setItem(this.ATTEMPTED_AUTH_TOKEN_SESSIONSTORAGE_KEY, this.userAuthToken);

      try {
        const response = await this.getSession();
        this.setUserName(response.name);
        this.setUserAuthKey(response.key);
      } catch (e) {
        // A pure network failure means the request never reached Last.fm, so
        // the token was not consumed and remains valid for a retry. Clear the
        // marker so a subsequent attempt (e.g. after reconnecting) can proceed.
        if (LastFm.isNetworkError(e)) {
          sessionStorage.removeItem(this.ATTEMPTED_AUTH_TOKEN_SESSIONSTORAGE_KEY);
        }
        throw e;
      } finally {
        // Token is consumed by auth.getSession (success or failure); discard it
        // so a retry doesn't reuse a dead token.
        this.userAuthToken = null;
      }
    }
  }

  /*
    Persist these values across sessions
  */
  public setUserAuthKey(authKey: string | null) {
    if (!authKey) {
      return;
    }
    localStorage.setItem(this.USER_AUTH_KEY_LOCALSTORAGE_KEY, authKey);
    this.userAuthKey = authKey;
  }

  public setUserAuthToken(authToken: string | null) {
    // Auth tokens are single-use and intentionally not persisted to localStorage.
    this.userAuthToken = authToken || null;
  }

  public setUserName(userName: string | null) {
    if (!userName) {
      return;
    }
    localStorage.setItem(this.USER_NAME_LOCALSTORAGE_KEY, userName);
    this.userName = userName;
  }

  public getUserName() {
    return this.userName;
  }

  public clearUser() {
    this.userAuthKey = null;
    this.userAuthToken = null;
    this.userName = null;
    localStorage.removeItem(this.USER_AUTH_KEY_LOCALSTORAGE_KEY);
    localStorage.removeItem(this.USER_AUTH_TOKEN_LOCALSTORAGE_KEY_LEGACY);
    localStorage.removeItem(this.USER_NAME_LOCALSTORAGE_KEY);
  }

  public isAuthenticated(): boolean {
    // A user is authenticated when we have a session key + username. The auth
    // token is only used once during the initial getSession exchange and is
    // not required (or valid) afterwards.
    return (this.userAuthKey !== null && this.userName !== null);
  }

  public async getPlaysInTimeRange(from: Date, to: Date): Promise<Scrobble[]> {
    if (this.userName === null) {
      throw new Error('Couldn\'t find username');
    }

    const requestParams: {[key: string]: string} = {
      method: 'user.getrecenttracks',
      user: this.userName,
      from: LastFm.dateToSecondsString(from, 'floor'),
      to: LastFm.dateToSecondsString(to, 'ceil'),
    };
    const response = await this.makeRequest('GET', requestParams);
    const tracks = response.recenttracks.track;
    if (!Array.isArray(tracks)) {
      return [];
    }
    return tracks
      .filter((track: any) => track.date)
      .map((track: any) => this.trackToScrobble(track));
  }

  /**
   * Fetch all scrobbles in a date range using paginated bulk requests.
   * Uses limit=1000 per page for maximum efficiency.
   * @param onProgress called with (fetchedSoFar, total) after each page
   */
  public async getAllScrobblesInRange(
    from: Date,
    to: Date,
    onProgress?: (fetched: number, total: number) => void,
  ): Promise<Scrobble[]> {
    if (this.userName === null) {
      throw new Error('Couldn\'t find username');
    }

    const PAGE_SIZE = 1000;
    const allScrobbles: Scrobble[] = [];

    // First request to get total count and first page
    const firstParams: {[key: string]: string} = {
      method: 'user.getrecenttracks',
      user: this.userName,
      from: LastFm.dateToSecondsString(from, 'floor'),
      to: LastFm.dateToSecondsString(to, 'ceil'),
      limit: PAGE_SIZE.toString(),
      page: '1',
    };
    const firstResponse = await this.makeRequest('GET', firstParams);
    const attr = firstResponse.recenttracks['@attr'];
    const totalPages = parseInt(attr.totalPages, 10);
    const total = parseInt(attr.total, 10);

    const firstTracks = firstResponse.recenttracks.track;
    if (Array.isArray(firstTracks)) {
      for (const track of firstTracks) {
        if (track.date) {
          allScrobbles.push(this.trackToScrobble(track));
        }
      }
    }

    if (onProgress) {
      onProgress(allScrobbles.length, total);
    }

    // Fetch remaining pages sequentially (respects rate buffer in makeRequest)
    for (let page = 2; page <= totalPages; page++) {
      const params: {[key: string]: string} = {
        method: 'user.getrecenttracks',
        user: this.userName,
        from: LastFm.dateToSecondsString(from, 'floor'),
        to: LastFm.dateToSecondsString(to, 'ceil'),
        limit: PAGE_SIZE.toString(),
        page: page.toString(),
      };
      const response = await this.makeRequest('GET', params);
      const tracks = response.recenttracks.track;
      if (Array.isArray(tracks)) {
        for (const track of tracks) {
          if (track.date) {
            allScrobbles.push(this.trackToScrobble(track));
          }
        }
      }
      if (onProgress) {
        onProgress(allScrobbles.length, total);
      }
    }

    return allScrobbles;
  }

  public async getTrackTimeMs(trackName: string, trackArtist: string): Promise<number> {
    // TODO this could be better done with musicbrainz/spotify api instead?
    // That way we wouldn't rely on last.fm's track length data
    const cacheKey = `${trackArtist.toLowerCase()}\u0000${trackName.toLowerCase()}`;
    const cached = this.trackDurationCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const requestParams = {
      method: 'track.getInfo',
      artist: trackArtist,
      track: trackName,
    };

    let response;
    try {
      response = await this.makeRequest('GET', requestParams);
    } catch (e) {
      // "Track not found" is a permanent answer, and a track a user played 40
      // times would otherwise be looked up (and rejected) 40 times. Rate limits
      // and network blips are *not* permanent, so those stay uncached.
      if (this.isLastFmApiError(e) && !LastFm.isRateLimitError(e)) {
        this.trackDurationCache.set(cacheKey, 0);
      }
      throw e;
    }

    // Last.fm happily returns a track with a missing, empty or non-numeric
    // duration. Returning NaN from here poisoned every downstream comparison
    // (every `NaN > x` is false), which silently discarded the play instead of
    // falling back to the caller's generous default. 0 means "unknown".
    const listenTime = parseInt(response.track && response.track.duration, 10);
    const durationMs = Number.isFinite(listenTime) && listenTime > 0 ? listenTime : 0;

    this.trackDurationCache.set(cacheKey, durationMs);
    return durationMs;
  }

  public async getSession(): Promise<any> {
    if (!this.userAuthToken) {
      throw new Error('Couldn\'t find an authentication token');
    }

    const requestParams = {
      method: 'auth.getSession',
      token: this.userAuthToken,
    };

    const response = await this.makeRequest('GET', requestParams, true);

    return response.session;
  }

  // https://www.last.fm/api/show/track.scrobble
  public async scrobblePlay(play: Scrobble, timestampSecOverride?: number): Promise<ScrobbleResult> {
    if (!this.userAuthKey) {
      throw new Error('Not authenticated.');
    }
    const timestampSec = timestampSecOverride !== undefined
      ? timestampSecOverride
      : Math.floor(play.timestamp.getTime() / 1000);
    const params: {[key: string]: string} = {
      method: 'track.scrobble',
      'artist[0]': play.artist,
      'track[0]': play.track,
      'timestamp[0]': timestampSec.toString(),
    };
    // Add album if available
    if (play.album) {
      params['album[0]'] = play.album;
    }
    const response = await this.makeRequest('POST', params, true);
    return LastFm.parseScrobbleResponse(response);
  }

  /**
   * A 200 from track.scrobble does not mean the play was stored. Last.fm
   * reports per-scrobble rejections in `ignoredMessage`, which this client used
   * to discard entirely — so expired timestamps and daily-limit rejections were
   * counted as successes.
   *
   * Defaults to "accepted" whenever the shape is unrecognised: an unparseable
   * response must never turn a working scrobble into a reported failure.
   */
  private static parseScrobbleResponse(response: any): ScrobbleResult {
    const attr = (response && response.scrobbles && response.scrobbles['@attr']) || {};
    let entry = response && response.scrobbles && response.scrobbles.scrobble;
    if (Array.isArray(entry)) {
      [entry] = entry;
    }
    const ignoredMessage = (entry && entry.ignoredMessage) || {};

    const accepted = Number(attr.accepted);
    const ignored = Number(attr.ignored);
    const code = Number(ignoredMessage.code);

    return {
      accepted: Number.isFinite(accepted) ? accepted : 1,
      ignored: Number.isFinite(ignored) ? ignored : 0,
      ignoredCode: Number.isFinite(code) ? code : 0,
      ignoredMessage: ignoredMessage['#text'] || '',
    };
  }

  /** https://www.last.fm/api/show/track.scrobble — ignoredMessage codes. */
  public static describeIgnoreCode(code: number, message: string): string {
    const known: {[key: number]: string} = {
      1: 'Last.fm ignored this artist',
      2: 'Last.fm ignored this track',
      3: 'Timestamp was too far in the past (Last.fm only accepts the last 14 days)',
      4: 'Timestamp was in the future',
      5: 'Daily scrobble limit reached',
    };
    return known[code] || message || `Last.fm ignored this scrobble (code ${code})`;
  }

  private async makeRequest(
    httpMethod: string,
    params: {[key: string]: string},
    authenticatedRequest = false,
    maxRetries = 3,
  ): Promise<any> {
    // Work on a copy so signing never writes credentials (api_key/sk/api_sig)
    // back into the caller's object.
    const requestParams: {[key: string]: string} = { ...params, api_key: this.lfmApiKey };

    // Decide which api key to use
    if (authenticatedRequest) {
      if (this.userAuthKey) {
        requestParams.sk = this.userAuthKey;
      }
      const sig = this.getMethodSignature(requestParams, this.userAuthToken || '');
      requestParams.api_sig = sig;
    }

    const paramsString = this.paramObjectToString(requestParams);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        let fetchResponse;
        if (httpMethod === 'POST') {
          fetchResponse = await fetch(this.API_BASE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `format=json&${paramsString}`,
          });
        } else {
          const requestURL = `${this.API_BASE_URL}?format=json&${paramsString}`;
          fetchResponse = await fetch(requestURL, { method: httpMethod });
        }

        // Retry on 429 (rate limited) or 5xx server errors
        if (fetchResponse.status === 429 || fetchResponse.status >= 500) {
          if (attempt < maxRetries) {
            const backoff = 2 ** (attempt + 1) * 1000;
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
        }

        const response = await fetchResponse.json();

        // Last.fm error code 29 = rate limit exceeded
        if (response.error === 29 && attempt < maxRetries) {
          const backoff = 2 ** (attempt + 1) * 1000;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        if (response.error) {
          throw new Error(this.buildLastFmErrorMessage(
            fetchResponse.status,
            response.error,
            response.message,
            requestParams,
          ));
        }

        await new Promise((r) => setTimeout(r, this.API_RATE_BUFFER_MS));

        return response;
      } catch (e) {
        if (attempt < maxRetries && !this.isLastFmApiError(e)) {
          const backoff = 2 ** (attempt + 1) * 1000;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw e;
      }
    }

    // Unreachable: the final attempt either returns or throws. Kept so the
    // method never resolves to undefined if the loop bounds ever change.
    throw new Error('Last.fm request exhausted all retries without a response');
  }

  private getMethodSignature(params: {[key: string]: any}, token: string) {
    const keys = Object.keys(params);
    keys.sort();
    let signature = '';
    keys.forEach((key) => {
      signature += `${key}${params[key]}`;
    });

    // Signature format described here: https://www.last.fm/api/webauth
    const toHash = signature + this.lfmSharedSecret;
    const hash = md5(toHash);
    return hash;
  }

  private paramObjectToString(params: {[key: string]: string}) {
    return Object.keys(params).map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`).join('&');
  }

  private buildLastFmErrorMessage(
    httpStatus: number,
    errorCode: number | string,
    errorMessage: string,
    params: {[key: string]: string},
  ): string {
    const safeParams = this.sanitizeRequestParams(params);
    const statusPart = httpStatus ? ` (HTTP ${httpStatus})` : '';
    return `Last.fm API error ${errorCode}${statusPart}: ${errorMessage}. Request: ${JSON.stringify(safeParams)}`;
  }

  private sanitizeRequestParams(params: {[key: string]: string}): {[key: string]: string} {
    const sensitiveKeys = new Set(['api_key', 'api_sig', 'sk', 'token']);
    return Object.keys(params).reduce((acc, key) => {
      acc[key] = sensitiveKeys.has(key) ? '[redacted]' : params[key];
      return acc;
    }, {} as {[key: string]: string});
  }

  private isLastFmApiError(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith('Last.fm API error');
  }

  public static isRateLimitError(error: unknown): boolean {
    // Last.fm error code 29 = Rate Limit Exceeded
    return error instanceof Error && /^Last\.fm API error 29\b/.test(error.message);
  }

  // Last.fm auth-token errors returned by auth.getSession. All of them mean the
  // token can never be exchanged again, so the only recovery is to send the user
  // back through the authorize flow to obtain a fresh token:
  //   4  = Invalid/unissued token ("This token has not been issued") — e.g. the
  //        single-use token was already consumed (by a link scanner, preview
  //        bot, prefetch, or an earlier tab) before this exchange ran.
  //   14 = This token has not been authorized by the user.
  //   15 = This token has expired (tokens are valid for ~60 minutes).
  public static isAuthTokenError(error: unknown): boolean {
    return error instanceof Error && /^Last\.fm API error (4|14|15)\b/.test(error.message);
  }

  // A failed `fetch` (offline, DNS failure, connection reset, CORS, ad-blocker,
  // etc.) rejects with a TypeError rather than an HTTP response. These are
  // transient connectivity problems, not a problem with a specific track, so
  // callers should pause and retry rather than treat the track as failed.
  // The message differs per browser: "Failed to fetch" (Chrome/Edge),
  // "NetworkError when attempting to fetch resource." (Firefox),
  // "Load failed" (Safari).
  public static isNetworkError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }
    if (error instanceof TypeError) {
      return true;
    }
    return /failed to fetch|networkerror|network request failed|load failed/i.test(error.message);
  }

  // TODO make a class for the api response instead of any
  private trackToScrobble(track: any): Scrobble {
    return new Scrobble(
      track.name,
      track.artist['#text'],
      new Date(parseInt(track.date.uts, 10) * 1000),
    );
  }

  /**
   * Last.fm expects integer UNIX timestamps. Sending `1784563202.848` is not
   * something the API promises to handle, and the fractional part appeared in
   * every `user.getrecenttracks` window the duplicate check requested.
   *
   * The two ends round outwards so the window can only ever widen: a duplicate
   * check that misses a scrobble writes a real duplicate into the user's
   * library, whereas one that looks slightly too far costs nothing.
   */
  private static dateToSecondsString(date: Date, round: 'floor' | 'ceil' = 'floor'): string {
    const seconds = date.getTime() / 1000;
    return String(round === 'ceil' ? Math.ceil(seconds) : Math.floor(seconds));
  }
}
