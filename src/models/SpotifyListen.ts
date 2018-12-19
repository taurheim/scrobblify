export default class SpotifyListen {
  // hack
  public key: number; // For table in step 3
  constructor(
    public artistName: string,
    public trackName: string,
    public listenDate: Date,
    public msPlayed: number,
  ) {
    this.key = listenDate.getTime();
  }

  public toString() {
    return `${this.trackName} - ${this.artistName}`;
  }
}
