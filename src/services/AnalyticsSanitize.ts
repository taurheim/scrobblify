/*
  Strips credentials out of the URLs PostHog attaches to every event.

  Two redirects land on `/scrobble` carrying secrets: the worker's return
  (`?handoff=ok&job=…#session=…&handoff=…&user=…`, and `?signin=ok#session=…&nonce=…`),
  whose `session` is a 14-day bearer token, and Last.fm's callback (`?token=…`).
  The app removes them from the address bar only after the first render, which
  is after the router's `$pageview` has been captured, and posthog-js adds
  `$current_url` to *every* event, so cleaning one capture site isn't enough.

  Everything after `?` is dropped, not just a denylist of parameter names, so a
  parameter added later can't leak by being forgotten here. The one thing kept
  is a hash-router route (`#/scrobble`), which is the page in dev's hash mode;
  any other fragment is dropped whole.
*/

// Properties posthog-js (or this app) fills with a page URL, path or referrer.
const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
  '$pathname',
  '$initial_pathname',
  '$prev_pageview_pathname',
  '$session_entry_url',
  '$session_entry_referrer',
  '$session_entry_pathname',
  'path',
];

export function sanitizeUrl(value: string): string {
  const hashAt = value.indexOf('#');
  const base = hashAt === -1 ? value : value.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : value.slice(hashAt);
  const queryAt = base.indexOf('?');
  const cleanBase = queryAt === -1 ? base : base.slice(0, queryAt);
  if (!hash.startsWith('#/')) {
    return cleanBase;
  }
  const hashQueryAt = hash.indexOf('?');
  return cleanBase + (hashQueryAt === -1 ? hash : hash.slice(0, hashQueryAt));
}

function sanitizeProperties<T extends Record<string, any> | undefined>(properties: T): T {
  if (!properties) {
    return properties;
  }
  const cleaned: Record<string, any> = { ...properties };
  URL_PROPERTIES.forEach((key) => {
    if (typeof cleaned[key] === 'string') {
      cleaned[key] = sanitizeUrl(cleaned[key]);
    }
  });
  return cleaned as T;
}

/**
 * A posthog-js `before_send` hook. Covers the event's properties and the
 * person properties set with it (`$set` / `$set_once` hold the `$initial_*`
 * copies). Never drops an event.
 */
export function sanitizeCapture<T extends {
  properties?: Record<string, any>;
  $set?: Record<string, any>;
  // eslint-disable-next-line camelcase
  $set_once?: Record<string, any>;
}>(capture: T | null): T | null {
  if (!capture) {
    return capture;
  }
  const cleaned = { ...capture };
  cleaned.properties = sanitizeProperties(capture.properties);
  if (capture.$set) {
    cleaned.$set = sanitizeProperties(capture.$set);
  }
  if (capture.$set_once) {
    cleaned.$set_once = sanitizeProperties(capture.$set_once);
  }
  return cleaned;
}
