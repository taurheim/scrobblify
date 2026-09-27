export type NotAProgressFileKind = 'extended_history' | 'account_data' | 'unknown';

/**
 * The file handed to StateManager.importFromFile() isn't a progress file at
 * all. Its message is written for the user, since this is a wrong-file mistake
 * rather than an app bug.
 */
export default class NotAProgressFileError extends Error {
  readonly detected: NotAProgressFileKind;

  constructor(detected: NotAProgressFileKind, message: string) {
    super(message);
    this.name = 'NotAProgressFileError';
    this.detected = detected;
  }
}
