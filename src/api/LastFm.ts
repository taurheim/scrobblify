import Scrobble from '@/models/Scrobble';

export default class LastFm {
  constructor(private apiKey: string) {
  }

  public async checkForConflict(scrobble: Scrobble): Promise<boolean> {
    return false;
  }

  public async postScrobble(scrobble: Scrobble): Promise<void> {
    return;
  }
}
