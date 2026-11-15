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
  add(play: MockPlay): void;
  countOnDay(uts: number): number;
}

export interface MockResponse {
  status: number;
  contentType: string;
  body: string;
}

export function interceptLastFm(page: Page, options?: { dailyCap?: number }): Promise<MockLibrary>;
export function mockLastFmAuth(page: Page): Promise<void>;
export function handleLastFm(params: URLSearchParams, library: MockLibrary): MockResponse;
export function createLibrary(dailyCap?: number): MockLibrary;
export function recordScrobble(library: MockLibrary, params: URLSearchParams, body: unknown): void;
export function lastFmAuthRedirect(basePath?: string): string;
export const MOCK_USER: string;
export const MOCK_SESSION_KEY: string;
