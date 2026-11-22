import { Page } from '@playwright/test';

export interface MockWorkerOptions {
  apiOrigin?: string;
  /** An empty string is a relative origin. */
  appOrigin?: string;
  log?: boolean;
  /** The Last.fm account an anonymous handoff or sign-in adopts. */
  username?: string;
  maxTracks?: number;
  capacityAvailable?: boolean;
  rate?: number;
  tickSeconds?: number;
}

export interface MockWorld {
  rate: number;
  tickSeconds: number;
  capacityAvailable: boolean;
  handoffs: Map<string, Record<string, unknown>>;
  imports: Map<string, Record<string, unknown>>;
  job: Record<string, unknown> | null;
}

export interface MockWorkerResponse {
  status: number;
  contentType?: string;
  headers?: Record<string, string>;
  body: string;
}

export interface MockWorker {
  world: MockWorld;
  handle(method: string, path: string, query: URLSearchParams, bodyText: string): MockWorkerResponse;
  apiOrigin: string;
  appOrigin: string;
}

export function createMockWorker(options?: MockWorkerOptions): MockWorker;
/** Routes the worker's origin and the `/mock-auth` shim on `page`. */
export function interceptBackgroundWorker(page: Page, options?: MockWorkerOptions): Promise<MockWorker>;
export function setState(job: Record<string, unknown>, state: string, nowMs: number): void;
export function shimHtml(session: string, handoffId: string, user?: string, fail?: string): string;
export function shimFromQuery(searchParams: URLSearchParams): string;
export const MIN_TRACKS: number;
export const DEFAULT_API_ORIGIN: string;
export const DEFAULT_APP_ORIGIN: string;
