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
    // Wait on a URL rather than the port: vue-cli-service accepts connections
    // before webpack's first compile finishes, so a port check lets tests start
    // while the dev server is still building. The first navigation then blocks
    // on that compile and eats the per-test timeout. Polling for a real 2xx
    // keeps the cold-start wait inside this (generous) webServer timeout.
    //
    // Must be the publicPath (see vue.config.js), not `/`: webpack only serves
    // the app there, and `/` just 404s for non-browser requests.
    url: 'http://localhost:8080/scrobblify/',
    reuseExistingServer: true,
    timeout: 180000,
  },
});
