export type ProgressFileProblem = 'read' | 'parse';

export const PROGRESS_FILE_READ_MESSAGE = 'Couldn\'t read this file. If it\'s stored in iCloud Drive, '
  + 'Google Drive or similar, download it to this device first, then choose it again.';

export const PROGRESS_FILE_DAMAGED_MESSAGE = 'This file is damaged and can\'t be read, so it can\'t be '
  + 'resumed. It may have been cut short while downloading or changed after it was saved. '
  + 'Try another copy of it, or an earlier progress file.';

/**
 * A chosen file couldn't be turned into JSON: the browser failed to read it
 * (`read`: an undownloaded cloud placeholder, a file moved since it was
 * chosen) or its text isn't valid JSON (`parse`: truncated, hand-edited). Says
 * nothing about whether it was the right file, so unlike NotAProgressFileError
 * the message doesn't blame the choice. `detail` is the underlying message, for
 * the user's "Technical details" only: a JSON.parse message quotes the file's
 * content, so it never goes to analytics (`trackingMessage` does).
 */
export default class ProgressFileUnreadableError extends Error {
  readonly problem: ProgressFileProblem;

  readonly detail: string;

  readonly trackingMessage: string;

  constructor(problem: ProgressFileProblem, cause: unknown) {
    super(problem === 'read' ? PROGRESS_FILE_READ_MESSAGE : PROGRESS_FILE_DAMAGED_MESSAGE);
    this.name = 'ProgressFileUnreadableError';
    this.problem = problem;
    let detail = '';
    try {
      detail = (cause as Error)?.message || String(cause ?? '');
    } catch {
      // A cause whose message can't be read just has no details.
    }
    this.detail = detail;
    this.trackingMessage = problem === 'read'
      ? detail || 'File could not be read'
      : 'Progress file is not valid JSON';
  }
}
