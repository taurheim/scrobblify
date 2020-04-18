import Scrobble from '@/models/Scrobble';
import LastFm from '@/api/LastFm';
import SpotifyListen from '@/models/SpotifyListen';
import Bluebird from 'bluebird';
import StringSimilarity from 'string-similarity';
import store from '@/store';

export default class Scrobblify {
  /*
    How much time around a given scrobble do we consider it a duplicate?
  */
  private MINUTES_TO_MS = 60000;
  private SECONDS_TO_MS = 1000;
  private DAYS_TO_MS = 86400000;
  private CONFLICT_BUFFER_TIME_MS = 3.5 * this.MINUTES_TO_MS;
  private RETROACTIVE_SCROBBLE_LIMIT_MS = 14 * this.DAYS_TO_MS;
  private retroactiveScrobbleLimitDate = (new Date()).getTime() - this.RETROACTIVE_SCROBBLE_LIMIT_MS;
  private lfmApi: LastFm;

  constructor(api: LastFm) {
    this.lfmApi = api;
  }

  public async isAlreadyScrobbled(proposedScrobble: Scrobble): Promise<boolean> {
    // Dice coefficient for track names
    const SAME_IF_COEFFICIENT_ABOVE = 0.9;
    const checkFrom = new Date(proposedScrobble.timestamp.getTime() - this.CONFLICT_BUFFER_TIME_MS);
    const checkTo = new Date(proposedScrobble.timestamp.getTime() + this.CONFLICT_BUFFER_TIME_MS);

    const scrobbledPlays = await this.lfmApi.getPlaysInTimeRange(checkFrom, checkTo);

    const wasScrobbled = scrobbledPlays.some((scrobbledPlay: Scrobble) => {
      const trackNameSimilarity =  StringSimilarity.compareTwoStrings(proposedScrobble.track, scrobbledPlay.track);
      return (
        scrobbledPlay.artist === proposedScrobble.artist &&
        trackNameSimilarity > SAME_IF_COEFFICIENT_ABOVE
      );
    });

    return wasScrobbled;
  }

  public async postScrobble(scrobble: Scrobble): Promise<void> {
    return;
  }

  public spotifyJsonToListens(jsonString: string): SpotifyListen[] {
    const parsedJson: any[] = JSON.parse(jsonString);
    return parsedJson.map((play) => {
      const allArtists: string[] = play.artistName.split(', ');

      return new SpotifyListen(
        allArtists[0], // The first artist is the one we'll use to scrobble
        play.trackName,
        new Date(`${play.endTime}`),
        play.msPlayed,
      );
    });
  }

  /*
    Spotify history includes all plays, regardless of how long the song is or how long
    you listened to it. Last.fm's policy on https://www.last.fm/api/scrobbling is much
    more strict. It states:

    A track should only be scrobbled when the following conditions have been met:
    - The track must be longer than 30 seconds.
    - And the track has been played for at least half its duration, or for 4 minutes (whichever occurs earlier.)

    Spotify tells us how long the user listened to the song so we can do this calculation.

    If 'assumeTrackLength' is enabled, we effectively ignore the second requirement by assuming the song is one
    minute long. This is not recommended but will speed up the uploads for users with a lot of songs to scrobble.
  */
  public async removeInvalidListens(
    listens: SpotifyListen[],
    progress: () => Promise<void>,
    assumeTrackLength: boolean,
  ): Promise<SpotifyListen[]> {
    const MINIMUM_LISTEN_PERCENT = 0.5;
    const MINIMUM_LISTEN_LENGTH_MS = 4 * this.MINUTES_TO_MS;
    const MINIMUM_TRACK_LENGTH_MS = 30 * this.SECONDS_TO_MS;
    const ASSUME_TRACK_LENGTH = 1 * this.MINUTES_TO_MS;

    // First get all the track lengths since we need to build a timeline
    const trackLengthsMs: number[] = await Bluebird.map(listens, async (listen: SpotifyListen) => {
      await progress();
      if (assumeTrackLength) {
        return ASSUME_TRACK_LENGTH;
      }
      try {
        return await this.lfmApi.getTrackTimeMs(listen.trackName, listen.artistName);
      } catch (e) {
        // Mark it as length 0
        return 0;
      }
    }, {
      concurrency: 1,
    });

    return listens.filter((listen, i) => {
      const msListened: number = listen.msPlayed;
      let currentTrackDurationMs: number = trackLengthsMs[i];

      // If the track reports as being length 0 pretend it's 2 minutes long
      // This way if they've listened to more than a minute we count it.
      // It's better to err on the side of giving them the scrobble as it will help populate their
      // last.fm history
      if (currentTrackDurationMs === 0) {
        currentTrackDurationMs = 2 * this.MINUTES_TO_MS;
      }

      // Plays under the minimum are always invalid
      if (currentTrackDurationMs < MINIMUM_TRACK_LENGTH_MS) {
        if (process.env.NODE_ENV !== 'production') {
          console.log(`Invalid due track duration: ${listen.toString()}: ${currentTrackDurationMs / this.MINUTES_TO_MS}`);
        }
        return false;
      }

      let msListenedToBeValid = currentTrackDurationMs * MINIMUM_LISTEN_PERCENT;

      if (msListenedToBeValid > MINIMUM_LISTEN_LENGTH_MS) {
        msListenedToBeValid = MINIMUM_LISTEN_LENGTH_MS;
      }

      const isValid = msListened > msListenedToBeValid;

      if (!isValid) {
        const minutes = msListened / this.MINUTES_TO_MS;
        const total = msListenedToBeValid / this.MINUTES_TO_MS;
        if (process.env.NODE_ENV !== 'production') {
          console.log(`INVALID: ${listen.toString()} - Only listened to the track for ${minutes} of ${total} minutes`);
        }
      }

      return isValid;
    });
  }
  /*
    In addition, the last.fm scrobbling api only allows 14 days prior to be scrobbled:
    https://getsatisfaction.com/lastfm/topics/scrobbles-more-than-14-days
  */
  public removeOldListens(listens: SpotifyListen[], reTagOldListens: boolean = false): SpotifyListen[] {
    return listens.filter((listen) => {
      const currentTrackStartedAt = listen.listenDate.getTime();
      return (currentTrackStartedAt > this.retroactiveScrobbleLimitDate);
    });
  }

  /*
    The 14 day limit can be circumvented by changing the listen date to a day within the last two weeks
  */
  public reTagOldListens(listens: SpotifyListen[], newDate: Date): SpotifyListen[] {
    return listens.map((listen) => {
      listen.listenDate = newDate;
      return listen;
    });
  }
}
