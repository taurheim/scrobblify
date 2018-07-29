export default class SpotifyListen {
  constructor(
    public artistName: string,
    public trackName: string,
    public time: Date,
  ) {
  }

  public toString() {
    return `${this.trackName} - ${this.artistName}`;
  }
}
