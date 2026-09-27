import { Page } from '@playwright/test';

export interface MockResponse {
  status: number;
  contentType: string;
  body: string;
}

export function interceptLastFm(page: Page): Promise<void>;
export function mockLastFmAuth(page: Page): Promise<void>;
export function handleLastFm(params: URLSearchParams): MockResponse;
export function lastFmAuthRedirect(basePath?: string): string;
export const MOCK_USER: string;
export const MOCK_SESSION_KEY: string;
