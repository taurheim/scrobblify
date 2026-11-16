export default class Scrobble {
  constructor(
    public track: string,
    public artist: string,
    public timestamp: Date,
    public album: string = '',
    /**
     * True when `timestamp` is a synthetic stand-in rather than a real listen
     * date, because the user asked to scrobble plays older than Last.fm's
     * 14-day retroactive limit.
     *
     * These must be re-stamped relative to the clock at send time. Baking an
     * absolute date in at parse time breaks resumes: a queue saved today and
     * resumed three weeks later would carry timestamps Last.fm now rejects as
     * too old (ignore code 3).
     */
    public reTagged: boolean = false,
  ) {
  }

  public toString() {
    return `${this.track} - ${this.artist}`;
  }
}

/**
 * A play Last.fm answered as accepted but has not yet been seen in the user's
 * library. `accepted` is not proof of storage (see shared/lastfm/dailyCap.ts), so a play only
 * counts as scrobbled once it is read back at exactly `timestampSec` — the
 * timestamp it was sent with, which for a re-tagged play differs from
 * `scrobble.timestamp`.
 */
export interface PendingScrobble {
  scrobble: Scrobble;
  timestampSec: number;
}
