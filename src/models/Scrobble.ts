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
