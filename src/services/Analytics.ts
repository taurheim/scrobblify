import posthog from 'posthog-js';

/*
  Lightweight wrapper around PostHog. Its purpose is to give visibility into
  where users run into errors so they can be helped. Analytics must NEVER break
  the app — every call is wrapped in a try/catch and silently ignored on failure.

  This project shares a PostHog instance with LastWave, so every event is tagged
  with `app: 'scrobblify'` (see APP_NAME) to keep the two apps' data separable.

  The key/host can be overridden at build time via VUE_APP_POSTHOG_KEY /
  VUE_APP_POSTHOG_HOST, but sensible defaults are baked in (the project API key
  is a public, client-side token, matching how the Last.fm keys are stored).
*/
const POSTHOG_KEY = process.env.VUE_APP_POSTHOG_KEY || 'phc_nhGFP4vdzuGrL5B7VGoeGRKcAtnPMvEsumoWhWTkp4a5';
const POSTHOG_HOST = process.env.VUE_APP_POSTHOG_HOST || 'https://us.i.posthog.com';
const APP_NAME = 'scrobblify';

let initialized = false;

export function initAnalytics(): void {
  if (initialized || !POSTHOG_KEY) {
    return;
  }
  // Don't pollute the (shared) production project with local dev / e2e-test
  // events. Only real users hitting the deployed site are tracked.
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') {
    return;
  }
  try {
    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      // Usage is tracked with explicit events, not automatic click/DOM capture.
      autocapture: false,
      capture_pageview: false,
      persistence: 'localStorage+cookie',
    });
    posthog.register({ app: APP_NAME });
    initialized = true;
  } catch (e) {
    // Analytics is best-effort; never let it break the app.
  }
}

export function trackEvent(event: string, properties: Record<string, any> = {}): void {
  if (!initialized) {
    return;
  }
  try {
    posthog.capture(event, properties);
  } catch (e) {
    // ignore
  }
}

export function trackPageView(path: string): void {
  if (!initialized) {
    return;
  }
  try {
    posthog.capture('$pageview', { $current_url: window.location.href, path });
  } catch (e) {
    // ignore
  }
}

/*
  Records an error against a named context (e.g. 'upload.parseZip') so failures
  can be grouped and investigated. Captures both a filterable custom event and,
  when available, PostHog's native exception so it shows up in error tracking.
*/
export function trackError(context: string, error: unknown, extra: Record<string, any> = {}): void {
  const err = error instanceof Error ? error : new Error(String(error));

  if (initialized) {
    try {
      posthog.capture('scrobblify_error', {
        context,
        message: err.message,
        stack: err.stack,
        ...extra,
      });
      const captureException = (posthog as any).captureException;
      if (typeof captureException === 'function') {
        captureException.call(posthog, err, { context, ...extra });
      }
    } catch (e) {
      // ignore
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    // eslint-disable-next-line no-console
    console.error(`[scrobblify:${context}]`, err, extra);
  }
}

/*
  Associates subsequent events with the user's Last.fm username. This makes it
  possible to look up a specific user's session when they report a problem.
*/
export function identifyUser(userName: string | null): void {
  if (!initialized || !userName) {
    return;
  }
  try {
    posthog.identify(userName, { lastfm_username: userName });
  } catch (e) {
    // ignore
  }
}

export function resetUser(): void {
  if (!initialized) {
    return;
  }
  try {
    posthog.reset();
  } catch (e) {
    // ignore
  }
}

export function registerGlobalErrorHandlers(): void {
  window.addEventListener('error', (event: ErrorEvent) => {
    trackError('window.onerror', event.error || event.message, {
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    trackError('unhandledrejection', event.reason);
  });
}
