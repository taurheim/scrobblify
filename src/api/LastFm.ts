import Scrobble from '@/models/Scrobble';
import Bluebird from 'bluebird';
import Request from 'request-promise';

export default class LastFm {
  private API_BASE_URL = 'https://ws.audioscrobbler.com/2.0/';
  private API_RATE_BUFFER_MS = 150;
  constructor(
    private user: string,
    private apiKey: string,
  ) {
  }

  public async getPlaysInTimeRange(from: Date, to: Date): Promise<Scrobble[]> {
    const requestParams: {[key: string]: string} = {
      method: 'user.getrecenttracks',
      format: 'json',
      user: this.user,
      api_key: this.apiKey,
      from: this.dateToSecondsString(from),
      to: this.dateToSecondsString(to),
    };
    const response = await this.makeRequest(requestParams);
    return response.recenttracks.track.map((track: any) => {
      return this.trackToScrobble(track);
    });
  }

  public async getTrackTimeMs(trackName: string, trackArtist: string): Promise<number> {
    // TODO this could be better done with musicbrainz/spotify api instead?
    // That way we wouldn't rely on last.fm's track length data
    const requestParams = {
      method: 'track.getInfo',
      api_key: this.apiKey,
      artist: trackArtist,
      track: trackName,
    };
    const response = await this.makeRequest(requestParams);

    const listenTime = parseInt(response.track.duration, 10);

    return listenTime;
  }

  private async makeRequest(params: {[key: string]: string}): Promise<any> {
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

  private paramObjectToString(params: {[key: string]: string}) {
    return Object.keys(params).map((key) => {
      return `${key}=${params[key]}`;
    }).join('&');
  }

  // TODO make a class for the api response instead of any
  private trackToScrobble(track: any): Scrobble {
    return new Scrobble(
      track.artist['#text'],
      track.name,
      new Date(parseInt(track.date.uts, 10) * 1000),
    );
  }

  private dateToSecondsString(date: Date): string {
    return (date.getTime() / 1000).toString();
  }
}
