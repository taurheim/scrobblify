/**
 * Thrown before any request is sent when there is no Last.fm session key to
 * sign it with — e.g. the key was cleared after Last.fm rejected it (error 9).
 * A class rather than a message so callers never have to match on text.
 */
export default class NotAuthenticatedError extends Error {
  constructor() {
    super('Not authenticated.');
    this.name = 'NotAuthenticatedError';
    // Keeps `instanceof` working if the class is ever down-levelled to ES5.
    Object.setPrototypeOf(this, NotAuthenticatedError.prototype);
  }
}
