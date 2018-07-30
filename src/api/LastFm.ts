import Scrobble from '@/models/Scrobble';
import Bluebird from 'bluebird';
import Request from 'request-promise';
import md5 from 'blueimp-md5';

export default class LastFm {
  private API_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
  private API_RATE_BUFFER_MS = 150;
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

  public clearUser() {
    this.userAuthKey = '';
    this.userAuthToken = '';
    this.userName = '';
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
    const response = await this.makeGetRequest(requestParams);
    return response.recenttracks.track.map((track: any) => {
      return this.trackToScrobble(track);
    });
  }

  public async getTrackTimeMs(trackName: string, trackArtist: string): Promise<number> {
    // TODO this could be better done with musicbrainz/spotify api instead?
    // That way we wouldn't rely on last.fm's track length data
    const requestParams = {
      method: 'track.getInfo',
      artist: trackArtist,
      track: trackName,
    };
    const response = await this.makeGetRequest(requestParams);

    const listenTime = parseInt(response.track.duration, 10);

    return listenTime;
  }

  public async getSession(): Promise<any> {
    if (!this.userAuthToken) {
      throw new Error('Couldn\'t find an authentication token');
    }

    const requestParams = {
      method: 'auth.getSession',
    };

    const response = await this.makeGetRequest(requestParams, true, true);

    return response.session;
  }

  // https://www.last.fm/api/show/track.scrobble
  public async scrobblePlay(play: Scrobble): Promise<void> {
    if (!this.userAuthToken ) {
      throw new Error('Not authenticated.');
    }

    const lfmMethod = 'track.scrobble';
    const response = await Request({
      method: 'POST',
      json: true,
      uri: this.API_BASE_URL,
      body: {
        method: lfmMethod,
        artist: [play.artist],
        track: [play.track],
        timestamp: [play.timestamp.getTime() / 1000],
        api_key: this.lfmApiKey,
        api_sig: this.getMethodSignature(lfmMethod, this.userAuthToken),
        sk: this.userAuthKey,
      },
    });

    console.log(response);

    await new Promise((r) => setTimeout(r, this.API_RATE_BUFFER_MS));

    return;
  }

  private async makeGetRequest(
    params: {[key: string]: string},
    authenticatedRequest: boolean = false,
    useAppApiKey: boolean = false,
  ): Promise<any> {
    if (this.userAuthToken === null) {
      throw new Error('Not authenticated!');
    }

    params.token = this.userAuthToken;

    // Decide which api key to use
    if (useAppApiKey) {
      params.api_key = this.lfmApiKey;
    } else if (this.userAuthKey !== null) {
      params.api_key = this.lfmApiKey;
      params.sk = this.userAuthKey;
    } else {
      throw new Error('User auth key not found.');
    }

    if (authenticatedRequest) {
      params.api_sig = this.getMethodSignature(params.method, this.userAuthToken);
    }

    const paramsString = this.paramObjectToString(params);
    const requestURL = `${this.API_BASE_URL}?format=json&${paramsString}`;

    const response = await Request(requestURL, {
      json: true,
    });

    if (response.error) {
      throw new Error(`Last.fm error on request: ${JSON.stringify(params)}`);
    }

    await new Promise((r) => setTimeout(r, this.API_RATE_BUFFER_MS));

    return response;
  }

  private getMethodSignature(method: string, token: string) {
    // Signature format described here: https://www.last.fm/api/webauth
    const signature = `api_key${this.lfmApiKey}method${method}token${token}`;
    return md5(encodeURI(signature) + this.lfmSharedSecret);
  }

  private paramObjectToString(params: {[key: string]: string}) {
    return Object.keys(params).map((key) => {
      return `${key}=${params[key]}`;
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
