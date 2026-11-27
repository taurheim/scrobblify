/**
 * How long a write to the saved session may take, opening the database
 * included, before it is given up as failed. A healthy save of a ~90k-track
 * queue takes about a second.
 */
export const STORAGE_WRITE_TIMEOUT_MS = 15000;

/**
 * A write the browser neither committed nor refused in time.
 *
 * IndexedDB can stall without firing anything (WebKit does in throttled tabs).
 * Waiting for it forever wedged the serialized save queue in `Scrobblify.vue`,
 * so every later checkpoint and stop save sat behind it unseen (#144).
 */
export default class StorageTimeoutError extends Error {
  constructor(timeoutMs: number = STORAGE_WRITE_TIMEOUT_MS) {
    super(`Saving progress in this browser did not finish within ${Math.round(timeoutMs / 1000)} seconds.`);
    this.name = 'StorageTimeoutError';
  }
}
