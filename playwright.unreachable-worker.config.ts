import { defineConfig } from '@playwright/test';

/*
  Runs `tests/unreachable-worker/` against a build that has a background worker
  URL compiled in, the way `.env.production` does, pointing at a host that can
  never resolve (`.invalid` is reserved by RFC 2606).

  The default config serves a build with no worker URL at all, where the whole
  background layer is inert. That hid the fact that an unreachable worker
  stopped *every* user from scrobbling, beta or not. This config is the only
  place that path runs.

  Its own port and never a reused server: `VUE_APP_*` is inlined at compile
  time, so adopting a server started without it would test nothing.
*/
const PORT = 8471;

export default defineConfig({
  testDir: './tests/unreachable-worker',
  timeout: 60000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
  },
  webServer: {
    command: `npx vue-cli-service serve --port ${PORT}`,
    url: `http://localhost:${PORT}/scrobblify/`,
    reuseExistingServer: false,
    timeout: 180000,
    env: {
      VUE_APP_BACKGROUND_API: 'http://background.invalid',
    },
  },
});
