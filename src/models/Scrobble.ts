export default class Scrobble {
  constructor(
    public artist: string,
    public track: string,
    public timestamp: Date,
  ) {
  }

  public toString() {
    return `${this.track} - ${this.artist}`;
  }
}
