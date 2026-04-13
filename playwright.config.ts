import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
  },
  webServer: {
    command: 'npx vue-cli-service serve --port 8080',
    port: 8080,
    reuseExistingServer: true,
    timeout: 60000,
  },
});
