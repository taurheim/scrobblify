import { trackEvent } from '@/services/Analytics';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/*
  Last.fm enforces its scrobble limits as a *rolling window* on the account, not
  as a fixed count that resets when our page reloads. The previous
  implementation counted scrobbles in a plain in-memory integer that started at
  zero on every mount, so a user who came back after being throttled immediately
  spent a budget they did not have. Telemetry showed 50% of first-in-streak rate
  limits happening at a burst count of zero.

  This tracker instead keeps the timestamps of recent successful scrobbles,
  persists them per Last.fm user, and answers the only question the scrobble
  loop actually cares about: "is it safe to send right now, and if not, for how
  long must I wait?".
*/

export const BURST_WINDOW_MS = 10 * MS_PER_MINUTE;
export const DAILY_WINDOW_MS = 24 * MS_PER_HOUR;

// Highest burst ever observed at the moment of a rate limit was 849, p90 was
// 747. We start meaningfully below that rather than at the old 950, and let the
// adaptive limit below discover each account's real ceiling from there.
export const DEFAULT_BURST_LIMIT = 500;

// Never throttle ourselves below this; at some point a smaller limit stops
// being caution and starts being a broken app.
export const MIN_BURST_LIMIT = 50;

// Last.fm's daily ceiling. Unlike the burst limit this one is well established,
// so it is not adapted — but it is now measured over a rolling 24 hours rather
// than a calendar day, which is both what Last.fm enforces and what removes the
// need for any day-rollover bookkeeping.
export const DAILY_LIMIT = 2700;

// When we do get rate limited, the number of sends we managed inside the burst
// window is direct evidence of where the real ceiling sits. Back off to a
// fraction of that so the next window stays clear of it.
const ADAPTIVE_BACKOFF_FACTOR = 0.8;

// Sustained success is evidence the limit is too conservative, so creep back up.
const ADAPTIVE_RECOVERY_FACTOR = 0.25;
const ADAPTIVE_RECOVERY_MIN_STEP = 25;
const ADAPTIVE_RECOVERY_AFTER_SENDS = 150;

const STORAGE_KEY_PREFIX = 'scrobblifyRateLimit';
const ANONYMOUS_USER_KEY = '__anonymous__';

interface PersistedRateLimitData {
  sends: number[];
  burstLimit: number;
  sendsSinceRateLimit: number;
}

export default class RateLimitTracker {
  private sends: number[] = [];

  private burstLimitValue: number = DEFAULT_BURST_LIMIT;

  private sendsSinceRateLimit = 0;

  private readonly storageKey: string;

  constructor(userName: string | null) {
    this.storageKey = `${STORAGE_KEY_PREFIX}:${userName || ANONYMOUS_USER_KEY}`;
    this.load();
  }

  public get burstLimit(): number {
    return this.burstLimitValue;
  }

  public get dailyLimit(): number {
    return DAILY_LIMIT;
  }

  public get burstCount(): number {
    return this.countSince(Date.now() - BURST_WINDOW_MS);
  }

  public get dailyCount(): number {
    return this.countSince(Date.now() - DAILY_WINDOW_MS);
  }

  /**
   * How long the caller must wait before a send would fit inside the burst
   * window. Zero means "safe to send now".
   */
  public msUntilBurstSafe(): number {
    return this.msUntilWindowHasRoom(BURST_WINDOW_MS, this.burstLimitValue);
  }

  /**
   * How long the caller must wait before a send would fit inside the 24 hour
   * window. Zero means "safe to send now".
   */
  public msUntilDailySafe(): number {
    return this.msUntilWindowHasRoom(DAILY_WINDOW_MS, DAILY_LIMIT);
  }

  public recordSend(timestamp: number = Date.now()): void {
    this.sends.push(timestamp);
    this.sendsSinceRateLimit += 1;

    if (this.sendsSinceRateLimit >= ADAPTIVE_RECOVERY_AFTER_SENDS
      && this.burstLimitValue < DEFAULT_BURST_LIMIT) {
      const step = Math.max(
        ADAPTIVE_RECOVERY_MIN_STEP,
        Math.floor(this.burstLimitValue * ADAPTIVE_RECOVERY_FACTOR),
      );
      this.burstLimitValue = Math.min(DEFAULT_BURST_LIMIT, this.burstLimitValue + step);
      this.sendsSinceRateLimit = 0;
      trackEvent('scrobble_burst_limit_raised', { burst_limit: this.burstLimitValue });
    }

    this.prune();
    this.save();
  }

  /**
   * Called when Last.fm actually rate limited us. The number of sends inside
   * the current burst window is evidence of where the real ceiling is, so pull
   * the limit down below it.
   *
   * If the window is (nearly) empty the limit cannot be what caused this — the
   * account was throttled by something outside our view, such as another device
   * or a session older than the window. Lowering our limit on that evidence
   * would cripple pacing for no reason, so we leave it alone.
   */
  public recordRateLimit(): void {
    const observed = this.burstCount;
    const previousLimit = this.burstLimitValue;
    this.sendsSinceRateLimit = 0;

    if (observed > MIN_BURST_LIMIT) {
      this.burstLimitValue = Math.max(
        MIN_BURST_LIMIT,
        Math.min(this.burstLimitValue, Math.floor(observed * ADAPTIVE_BACKOFF_FACTOR)),
      );
    }
    this.save();

    if (this.burstLimitValue !== previousLimit) {
      trackEvent('scrobble_burst_limit_lowered', {
        burst_limit: this.burstLimitValue,
        previous_burst_limit: previousLimit,
        observed_burst_count: observed,
      });
    }
  }

  /**
   * Seed the window from a legacy saved session that only recorded counts, not
   * timestamps. The individual send times are unknown, so they are treated as
   * having happened in the run-up to `savedAtMs` — pessimistic by design, since
   * assuming the budget is already spent is far cheaper than assuming it is free.
   *
   * Anything that has since aged out of its window is dropped by `prune()` and
   * by the window queries, so an old save correctly contributes nothing.
   */
  public seedFromLegacyCounts(burstCount: number, dailyCount: number, savedAtMs: number): void {
    if (this.sends.length > 0) {
      return;
    }

    const now = Date.now();
    const savedAt = Number.isFinite(savedAtMs) ? Math.min(savedAtMs, now) : now;
    const safeDaily = Math.max(0, Math.floor(dailyCount));
    const safeBurst = Math.min(Math.max(0, Math.floor(burstCount)), safeDaily || 0);

    const seeded: number[] = [];
    // Sends older than the burst window, spread back over the preceding 24h.
    const olderDaily = safeDaily - safeBurst;
    for (let i = 0; i < olderDaily; i++) {
      const age = BURST_WINDOW_MS
        + ((DAILY_WINDOW_MS - BURST_WINDOW_MS) * (olderDaily - i)) / (olderDaily + 1);
      seeded.push(savedAt - age);
    }
    // The burst sends are the most recent ones, immediately before the save.
    for (let i = 0; i < safeBurst; i++) {
      seeded.push(savedAt - (BURST_WINDOW_MS * (safeBurst - i)) / (safeBurst + 1));
    }

    this.sends = seeded;
    this.prune();
    this.save();
  }

  public getSendTimestamps(): number[] {
    this.prune();
    return [...this.sends];
  }

  public setSendTimestamps(timestamps: number[]): void {
    this.sends = timestamps.filter((t) => typeof t === 'number' && Number.isFinite(t));
    this.prune();
    this.save();
  }

  public clear(): void {
    this.sends = [];
    this.burstLimitValue = DEFAULT_BURST_LIMIT;
    this.sendsSinceRateLimit = 0;
    try {
      localStorage.removeItem(this.storageKey);
    } catch (e) {
      // Storage unavailable (private mode, quota, disabled) — not fatal.
    }
  }

  private countSince(cutoff: number): number {
    let count = 0;
    for (let i = this.sends.length - 1; i >= 0; i--) {
      if (this.sends[i] < cutoff) {
        break;
      }
      count++;
    }
    return count;
  }

  private msUntilWindowHasRoom(windowMs: number, limit: number): number {
    const now = Date.now();
    const cutoff = now - windowMs;
    const inWindow = this.countSince(cutoff);
    if (inWindow < limit) {
      return 0;
    }
    // The oldest send we need to expire is the one `limit - 1` back from the
    // newest; once it leaves the window there is room for exactly one more.
    const index = this.sends.length - limit;
    const oldestRelevant = this.sends[Math.max(0, index)];
    return Math.max(0, (oldestRelevant + windowMs) - now);
  }

  private prune(): void {
    const cutoff = Date.now() - DAILY_WINDOW_MS;
    // `sends` is append-only in ascending order, so everything before the first
    // in-window entry can be dropped in one slice.
    let firstValid = 0;
    while (firstValid < this.sends.length && this.sends[firstValid] < cutoff) {
      firstValid++;
    }
    if (firstValid > 0) {
      this.sends = this.sends.slice(firstValid);
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as PersistedRateLimitData;
      if (Array.isArray(parsed.sends)) {
        this.sends = parsed.sends.filter((t) => typeof t === 'number' && Number.isFinite(t));
      }
      if (typeof parsed.burstLimit === 'number' && Number.isFinite(parsed.burstLimit)) {
        this.burstLimitValue = Math.min(
          DEFAULT_BURST_LIMIT,
          Math.max(MIN_BURST_LIMIT, parsed.burstLimit),
        );
      }
      if (typeof parsed.sendsSinceRateLimit === 'number') {
        this.sendsSinceRateLimit = parsed.sendsSinceRateLimit;
      }
      this.prune();
    } catch (e) {
      // Corrupt or unavailable storage — fall back to a clean window.
      this.sends = [];
    }
  }

  private save(): void {
    try {
      const data: PersistedRateLimitData = {
        sends: this.sends,
        burstLimit: this.burstLimitValue,
        sendsSinceRateLimit: this.sendsSinceRateLimit,
      };
      localStorage.setItem(this.storageKey, JSON.stringify(data));
    } catch (e) {
      // Storage unavailable or over quota. Losing persistence degrades us to
      // the old in-memory behaviour rather than breaking scrobbling.
    }
  }
}
