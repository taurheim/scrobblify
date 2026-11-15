export default class SpotifyListen {
  // hack
  public key: number; // For table in step 3

  public originalListenDate: Date;

  /** See Scrobble.reTagged — set by Scrobblify.reTagOldListens. */
  public reTagged = false;

  constructor(
    public artistName: string,
    public trackName: string,
    public listenDate: Date,
    public msPlayed: number,
    public albumName: string = '',
  ) {
    this.key = listenDate.getTime();
    this.originalListenDate = new Date(listenDate.getTime());
  }

  public toString() {
    return `${this.trackName} - ${this.artistName}`;
  }
}
