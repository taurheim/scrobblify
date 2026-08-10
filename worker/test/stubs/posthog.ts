/**
 * Stands in for `posthog-js` when a client module is bundled into a test.
 *
 * Analytics must never change behaviour, so the stub only has to exist. Every
 * call in `src/services/Analytics.ts` is already wrapped in try/catch and its
 * failures are swallowed by design; this simply avoids importing a browser
 * library into Node, which touches `window` at module scope.
 */
const posthog = {
  init() { /* no-op */ },
  capture() { /* no-op */ },
  identify() { /* no-op */ },
  reset() { /* no-op */ },
  captureException() { /* no-op */ },
  __loaded: false,
};

export default posthog;
