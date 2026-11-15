/* eslint-disable import/no-extraneous-dependencies */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  grep: /(legacy browser-only progress resumes|identified saved progress stays fail-closed) while the background service is unavailable/,
  timeout: 30000,
  metadata: {
    backgroundAuthority: true,
  },
  use: {
    baseURL: 'http://localhost:8081',
    headless: true,
  },
  webServer: {
    command: 'npx vue-cli-service serve --port 8081',
    env: {
      ...process.env,
      VUE_APP_BACKGROUND_API: 'http://background.invalid',
    },
    url: 'http://localhost:8081/scrobblify/',
    reuseExistingServer: false,
    timeout: 180000,
  },
});
