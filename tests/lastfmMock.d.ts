import { Page } from '@playwright/test';

export function interceptLastFm(page: Page): Promise<void>;
export function mockLastFmAuth(page: Page): Promise<void>;
