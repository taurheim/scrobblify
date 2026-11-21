import { Page } from '@playwright/test';

export interface MockPlay {
  track: string;
  artist: string;
  album: string;
  /** Unix seconds. */
  uts: number;
}

export interface MockLibrary {
  /** Every play the mock "stored", in arrival order. */
  plays: MockPlay[];
  /** Plays kept per UTC day of the timestamp; the rest are accepted and dropped. */
  dailyCap: number;
  /** Unsigned `user.getrecenttracks` is refused with error 17; signed reads work. */
  hiddenProfile: boolean;
  /** Every `user.getrecenttracks` fails with this Last.fm error code (0 = off). */
  recentTracksError: number;
  add(play: MockPlay): void;
  countOnDay(uts: number): number;
}

export interface MockResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface MockLibraryOptions {
  hiddenProfile?: boolean;
  recentTracksError?: number;
}

export function interceptLastFm(
  page: Page,
  options?: { dailyCap?: number } & MockLibraryOptions,
): Promise<MockLibrary>;
export function mockLastFmAuth(page: Page): Promise<void>;
/** Answers Last.fm's authorize page with a redirect back to the app, signed in as MOCK_USER. */
export function routeLastFmSignIn(page: Page): Promise<void>;
export function handleLastFm(params: URLSearchParams, library: MockLibrary): MockResponse;
export function createLibrary(dailyCap?: number, options?: MockLibraryOptions): MockLibrary;
export function recordScrobble(library: MockLibrary, params: URLSearchParams, body: unknown): void;
export function lastFmAuthRedirect(basePath?: string): string;
export const MOCK_USER: string;
export const MOCK_SESSION_KEY: string;
