import Scrobble from '@/models/Scrobble';
import md5 from 'blueimp-md5';

export default class LastFm {
  private API_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
  private API_RATE_BUFFER_MS = 250;
  private USER_AUTH_TOKEN_LOCALSTORAGE_KEY = 'scrobblifyLfmAuthToken';
  private USER_AUTH_KEY_LOCALSTORAGE_KEY = 'scrobblifyLfmAuthKey';
  private USER_NAME_LOCALSTORAGE_KEY = 'scrobblifyLfmUserName';
  private userAuthKey: string | null = null;
  private userAuthToken: string | null = null;
  private userName: string | null = null;
  constructor(
    private lfmApiKey: string,
    private lfmSharedSecret: string,
  ) {
  }

  public async init(queryParams: any) {
    this.setUserAuthKey(localStorage.getItem(this.USER_AUTH_KEY_LOCALSTORAGE_KEY));
    this.setUserAuthToken(localStorage.getItem(this.USER_AUTH_TOKEN_LOCALSTORAGE_KEY) || queryParams.token);
    this.setUserName(localStorage.getItem(this.USER_NAME_LOCALSTORAGE_KEY));

    if (!this.isAuthenticated() && this.userAuthToken) {
      // Get the session auth
      const response = await this.getSession();
      this.setUserName(response.name);
      this.setUserAuthKey(response.key);
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
    if (!authToken) {
      return;
    }
    localStorage.setItem(this.USER_AUTH_TOKEN_LOCALSTORAGE_KEY, authToken);
    this.userAuthToken = authToken;
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
    localStorage.removeItem(this.USER_AUTH_TOKEN_LOCALSTORAGE_KEY);
    localStorage.removeItem(this.USER_NAME_LOCALSTORAGE_KEY);
  }

  public isAuthenticated(): boolean {
    return (this.userAuthKey !== null && this.userAuthToken !== null && this.userName !== null);
  }

  public async getPlaysInTimeRange(from: Date, to: Date): Promise<Scrobble[]> {
    if (this.userName === null) {
      throw new Error('Couldn\'t find username');
    }

    const requestParams: {[key: string]: string} = {
      method: 'user.getrecenttracks',
      user: this.userName,
      from: this.dateToSecondsString(from),
      to: this.dateToSecondsString(to),
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
      from: this.dateToSecondsString(from),
      to: this.dateToSecondsString(to),
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
        from: this.dateToSecondsString(from),
        to: this.dateToSecondsString(to),
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
    const requestParams = {
      method: 'track.getInfo',
      artist: trackArtist,
      track: trackName,
    };
    const response = await this.makeRequest('GET', requestParams);

    const listenTime = parseInt(response.track.duration, 10);

    return listenTime;
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
  public async scrobblePlay(play: Scrobble): Promise<void> {
    if (!this.userAuthToken ) {
      throw new Error('Not authenticated.');
    }
    const params: {[key: string]: any} = {
      'method': 'track.scrobble',
      'artist[0]': play.artist,
      'track[0]': play.track,
      'timestamp[0]': play.timestamp.getTime() / 1000,
    };
    // Add album if available
    if (play.album) {
      params['album[0]'] = play.album;
    }
    await this.makeRequest('POST', params, true);
  }

  private async makeRequest(
    httpMethod: string,
    params: {[key: string]: string},
    authenticatedRequest: boolean = false,
    maxRetries: number = 3,
  ): Promise<any> {
    params.api_key = this.lfmApiKey;

    // Decide which api key to use
    if (authenticatedRequest) {
      if (this.userAuthKey) {
        params.sk = this.userAuthKey;
      }
      const sig = this.getMethodSignature(params, this.userAuthToken || '');
      params.api_sig = sig;
    }

    const paramsString = this.paramObjectToString(params);

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
            const backoff = Math.pow(2, attempt + 1) * 1000;
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
        }

        const response = await fetchResponse.json();

        // Last.fm error code 29 = rate limit exceeded
        if (response.error === 29 && attempt < maxRetries) {
          const backoff = Math.pow(2, attempt + 1) * 1000;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }

        if (response.error) {
          throw new Error(`Last.fm error on request: ${JSON.stringify(params)}`);
        }

        await new Promise((r) => setTimeout(r, this.API_RATE_BUFFER_MS));

        return response;
      } catch (e) {
        if (attempt < maxRetries && !(e instanceof Error && e.message.startsWith('Last.fm error'))) {
          const backoff = Math.pow(2, attempt + 1) * 1000;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw e;
      }
    }
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
    return Object.keys(params).map((key) => {
      return `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`;
    }).join('&');
  }

  // TODO make a class for the api response instead of any
  private trackToScrobble(track: any): Scrobble {
    return new Scrobble(
      track.name,
      track.artist['#text'],
      new Date(parseInt(track.date.uts, 10) * 1000),
    );
  }

  private dateToSecondsString(date: Date): string {
    return (date.getTime() / 1000).toString();
  }
}
