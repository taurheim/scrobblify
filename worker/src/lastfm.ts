/**
 * Server-side Last.fm client.
 *
 * Deliberately thin: everything that describes *how Last.fm behaves* lives in
 * the shared protocol module so the SPA and the worker cannot drift. This file
 * only adds transport.
 *
 * Uses plain `fetch` so it runs unchanged on a VM (spec "Portability
 * requirements"). It has no retry loop of its own — retries are the scheduler's
 * job, because only the scheduler knows about the global circuit breaker, the
 * lease it holds, and whether a batch's outcome was already recorded.
 */
import {
  buildLastFmErrorMessage,
  buildScrobbleParams,
  encodeParams,
  parseScrobbleResponse,
  signParams,
  MAX_SCROBBLES_PER_BATCH,
  type BatchScrobbleResult,
  type ScrobbleEntry,
} from '../../src/shared/lastfm/protocol';

const API_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';

/**
 * Bounds a hung Last.fm request. Without this a stalled connection can hold a
 * job's lease open until it expires, which is precisely the situation that
 * invites a second tick to take over and duplicate work.
 */
const REQUEST_TIMEOUT_MS = 15_000;

export interface LastFmCredentials {
  apiKey: string;
  sharedSecret: string;
}

export class LastFmClient {
  constructor(private readonly credentials: LastFmCredentials) {}

  private async request(
    params: { [key: string]: string },
    signed: boolean,
  ): Promise<any> {
    const requestParams: { [key: string]: string } = {
      ...params,
      api_key: this.credentials.apiKey,
    };
    if (signed) {
      requestParams.api_sig = signParams(requestParams, this.credentials.sharedSecret);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(API_BASE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `format=json&${encodeParams(requestParams)}`,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Read as text first: Last.fm returns HTML error pages under load, and
    // `response.json()` on one throws a SyntaxError that looks nothing like the
    // rate limit it usually is.
    const raw = await response.text();
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new Error(
        buildLastFmErrorMessage(
          response.status,
          'non-json',
          'Last.fm returned a non-JSON response',
          requestParams,
        ),
      );
    }

    if (body && typeof body.error === 'number') {
      throw new Error(
        buildLastFmErrorMessage(response.status, body.error, body.message || '', requestParams),
      );
    }
    if (!response.ok) {
      throw new Error(
        buildLastFmErrorMessage(response.status, 'http', response.statusText, requestParams),
      );
    }
    return body;
  }

  /**
   * Exchanges a single-use auth token for a permanent session key.
   *
   * The returned username is not decoration: it is the only evidence of *whose*
   * account the credential controls, and the caller must compare it against the
   * username recorded before the redirect. Skipping that check allows one
   * account's history to be written into another's.
   */
  public async getSession(token: string): Promise<{ sessionKey: string; username: string }> {
    const body = await this.request({ method: 'auth.getSession', token }, true);
    const session = body && body.session;
    if (!session || typeof session.key !== 'string' || typeof session.name !== 'string') {
      throw new Error('Last.fm auth.getSession returned no session');
    }
    return { sessionKey: session.key, username: session.name };
  }

  /**
   * Sends up to 50 scrobbles.
   *
   * Returns one outcome per submitted entry. A 200 does not mean the plays were
   * stored: rejections arrive per entry in `ignoredMessage`, and the caller may
   * only advance its cursor over entries Last.fm actually accepted.
   */
  public async scrobbleBatch(
    entries: ScrobbleEntry[],
    sessionKey: string,
  ): Promise<BatchScrobbleResult> {
    if (entries.length > MAX_SCROBBLES_PER_BATCH) {
      throw new Error(`scrobbleBatch: ${entries.length} exceeds ${MAX_SCROBBLES_PER_BATCH}`);
    }
    const params = buildScrobbleParams(entries);
    params.sk = sessionKey;
    const body = await this.request(params, true);
    return parseScrobbleResponse(body, entries.length);
  }

  /**
   * Recent tracks in a window, used to reconcile after an unclean tick.
   *
   * `limit` is capped at 200 by Last.fm — the SPA's `PAGE_SIZE = 1000` is a
   * pre-existing bug and must not be copied here. `from`/`to` are strictly
   * exclusive, so callers widen the window by a second on each side.
   */
  public async getRecentTracks(
    username: string,
    fromSec: number,
    toSec: number,
    sessionKey: string,
    limit = 200,
  ): Promise<{ artist: string; track: string; timestampSec: number }[]> {
    const body = await this.request(
      {
        method: 'user.getRecentTracks',
        user: username,
        from: String(fromSec),
        to: String(toSec),
        limit: String(Math.min(limit, 200)),
        sk: sessionKey,
      },
      true,
    );

    let tracks = body && body.recenttracks && body.recenttracks.track;
    if (tracks && !Array.isArray(tracks)) {
      tracks = [tracks];
    }
    if (!Array.isArray(tracks)) {
      return [];
    }
    return tracks
      // A currently-playing track has no `date` and is not a completed scrobble.
      .filter((t: any) => t && t.date && t.date.uts)
      .map((t: any) => ({
        artist: (t.artist && (t.artist['#text'] || t.artist.name)) || '',
        track: t.name || '',
        timestampSec: Number(t.date.uts),
      }));
  }
}
