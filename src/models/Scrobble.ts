export default class Scrobble {
  constructor(
    public track: string,
    public artist: string,
    public timestamp: Date,
    public album: string = '',
  ) {
  }

  public toString() {
    return `${this.track} - ${this.artist}`;
  }
}
