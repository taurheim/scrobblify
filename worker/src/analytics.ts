export interface WorkerAnalytics {
  capture(
    event: string,
    distinctId: string,
    properties: Record<string, unknown>,
  ): Promise<void>;
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PostHogAnalyticsOptions {
  token: string;
  host: string;
  fetch?: Fetch;
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Minimal PostHog HTTP adapter for runtimes where posthog-js is unavailable.
 *
 * The project token is a public ingestion token, not a personal API key.
 * Capture is deliberately best-effort: analytics must never alter scheduler
 * state, retry timing, or whether a scrobble is sent.
 */
export class PostHogAnalytics implements WorkerAnalytics {
  private readonly fetch: Fetch;

  private readonly host: string;

  constructor(private readonly options: PostHogAnalyticsOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.host = (options.host || '').replace(/\/+$/, '');
  }

  async capture(
    event: string,
    distinctId: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    if (!this.options.token || !this.host) {
      return;
    }
    try {
      const delivery = this.fetch(`${this.host}/capture/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: this.options.token,
          event,
          properties: {
            ...properties,
            distinct_id: distinctId,
            app: 'scrobblify',
            $lib: 'scrobblify-worker',
          },
        }),
      }).then(() => undefined).catch(() => undefined);
      if (this.options.waitUntil) {
        this.options.waitUntil(delivery);
        return;
      }
      await delivery;
    } catch {
      // Best-effort by contract.
    }
  }
}
