# Guided Home, About and BETA Tag Implementation Plan (Plan 1 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec PRs 1 and 2 of `docs/superpowers/specs/2026-11-20-guided-home-and-background-design.md`: a static BETA tag in the header (replacing the beta banner), the new Home page (first visit, "get your history" steps, returning-visitor card) and the About page with a collapsible FAQ.

**Architecture:** `App.vue` consumes `?beta=` and shows the tag. `Home.vue` becomes a small shell that asks a new pure-ish service, `src/services/ReturningVisitor.ts`, which state to render, and delegates to two new components in `src/components/home/`. A new localStorage record, the handed-over import id, lets Home show a server job's progress after the local queue has been cleared. About is rewritten with `v-expansion-panels`.

**Tech Stack:** Vue 3 (Options API, `defineComponent`), Vuetify 4, Vuex, TypeScript, Playwright.

**Out of scope for this plan (later plans):** sign-in after choosing, the server choice dialog, the status page, worker changes. Until Plan 3, Home's **Continue** and "Re-connect to last.fm" simply open `/scrobble`, where today's sign-in step and resume banner take over.

**Copy:** every user-facing string below is final, from `docs/superpowers/specs/2026-11-20-guided-home-strings.md`. Do not reword. Strings that are blank there are deliberately not rendered.

---

## Before you start

Read `AGENTS.md` sections "Local servers and ports" and "Running the tests". In short:

- Pick a free port once and reuse it. **Set `PORT` in the same command** that runs Playwright, every time:

  ```powershell
  $port = Get-Random -Minimum 8100 -Maximum 9000
  while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port++ }
  $port   # remember it; the commands below write it as <PORT>
  ```

- Default-config tests: `$env:PORT=<PORT>; npx playwright test tests/scrobblify.spec.ts -g "<name>"`
- Worker-configured tests (anything needing `isBackgroundConfigured()`): `npx playwright test -c playwright.unreachable-worker.config.ts -g "<name>"`. That config always builds its own server on port 8471.
- Lint as CI does: `npm run lint:check`.

Nothing is captured from localhost, so tests read telemetry from the console echo with the existing `captureEvents(page)` helper in `tests/scrobblify.spec.ts`.

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `src/App.vue` | Modify | Consume `?beta=`; render the BETA tag |
| `src/components/Scrobblify.vue` | Modify | Remove the beta banner and its plumbing; clear the handed-over import on take-back |
| `src/services/BackgroundScrobbling.ts` | Modify | Handed-over import id record |
| `src/services/BackgroundHandoff.ts` | Modify | Write that record when a handover goes live |
| `src/services/ReturningVisitor.ts` | Create | Decide which Home state to show |
| `src/components/home/HomeGetExport.vue` | Create | The three "get your history" steps |
| `src/components/home/HomeReturning.vue` | Create | The returning-visitor card |
| `src/views/Home.vue` | Rewrite | Shell: first visit / get-export / returning |
| `src/views/About.vue` | Rewrite | Lede, FAQ, kept sections |
| `tests/scrobblify.spec.ts` | Modify | Home and About tests |
| `tests/unreachable-worker/unreachable-worker.spec.ts` | Modify | BETA tag and server-job card tests |
| `AGENTS.md` | Modify | Telemetry and beta-gate docs |

---

### Task 1: BETA tag in the header, beta banner removed

**Files:**
- Modify: `src/App.vue`
- Modify: `src/components/Scrobblify.vue`
- Test: `tests/unreachable-worker/unreachable-worker.spec.ts`, `tests/scrobblify.spec.ts`

- [ ] **Step 1: Write the failing tests (worker-configured build)**

Append to `tests/unreachable-worker/unreachable-worker.spec.ts`:

```ts
test.describe('BETA tag', () => {
  const TAG = '#logo .beta-tag';

  test('an opted-in browser sees the BETA tag on every page', async ({ page }) => {
    await page.goto('/?beta=1#/');
    await expect(page.locator(TAG)).toHaveText('BETA');
    await page.goto('/#/about');
    await expect(page.locator(TAG)).toBeVisible();
  });

  test('the rollout flag shows the tag without the opt-in', async ({ page }) => {
    await page.goto('/#/');
    await page.evaluate(() => window.localStorage.setItem(
      'scrobblify.flags',
      JSON.stringify({ 'scrobblify-background-scrobbling': true }),
    ));
    await page.reload();
    await expect(page.locator(TAG)).toBeVisible();
  });

  test('a browser outside the beta sees no tag and no beta banner', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.locator('#logo')).toBeVisible();
    await expect(page.locator(TAG)).toHaveCount(0);
    await page.goto('/?beta=1#/scrobble');
    await expect(page.locator(TAG)).toBeVisible();
    await expect(page.locator('text=Background scrobbling (beta) is switched on')).toHaveCount(0);
  });

  test('?beta=0 removes the tag again', async ({ page }) => {
    await page.goto('/?beta=1#/');
    await expect(page.locator(TAG)).toBeVisible();
    await page.goto('/?beta=0#/');
    await expect(page.locator('#logo')).toBeVisible();
    await expect(page.locator(TAG)).toHaveCount(0);
  });
});
```

Add to the `Home Page` describe in `tests/scrobblify.spec.ts` (this build has no worker URL, so the beta can never be on):

```ts
  test('shows no BETA tag in a build without a worker, even with ?beta=1', async ({ page }) => {
    await page.goto('/?beta=1#/');
    await expect(page.locator('#logo')).toBeVisible();
    await expect(page.locator('#logo .beta-tag')).toHaveCount(0);
  });
```

- [ ] **Step 2: Run them to see the worker-configured ones fail**

Run: `npx playwright test -c playwright.unreachable-worker.config.ts -g "BETA tag"`
Expected: the first two and the fourth FAIL (no `.beta-tag`); the third FAILS on `toBeVisible` for `/scrobble?beta=1` or on the banner still existing.

Run: `$env:PORT=<PORT>; npx playwright test tests/scrobblify.spec.ts -g "no BETA tag"`
Expected: PASS already (the tag does not exist yet). It guards the later change.

- [ ] **Step 3: Render the tag in `src/App.vue`**

Replace:

```html
      <div id="logo">
        <img src="./assets/logo.png" alt=""> scrobblify
      </div>
```

with:

```html
      <div id="logo">
        <img src="./assets/logo.png" alt=""> scrobblify
        <v-chip
          v-if="betaTag"
          class="beta-tag ml-1"
          size="x-small"
          color="deep-purple"
          variant="flat"
        >BETA</v-chip>
      </div>
```

In the `<script>`, change the imports:

```ts
import { DeployedBuild, compareDeployedBuild, fetchDeployedBuild } from './services/BuildCheck';
import { onFeatureFlags, trackEvent } from './services/Analytics';
import { consumeBetaParam, isBackgroundEnabled } from './services/BackgroundScrobbling';
```

Add to `data()`:

```ts
      // Shown whenever this browser is offered background scrobbling. Refreshed
      // when PostHog flags load or the user is identified.
      betaTag: false,
      releaseFlagListener: null as (() => void) | null,
```

Add a `created()` hook (before `mounted()`):

```ts
  created() {
    /*
      `?beta=1` / `?beta=0` is applied here, once per page load, so an invite
      link works on any page and not only /scrobble. Children mount after
      this, so their offer checks already see the opt-in.
    */
    consumeBetaParam();
    this.betaTag = isBackgroundEnabled();
  },
```

In `mounted()`, add as the first line:

```ts
    this.releaseFlagListener = onFeatureFlags(() => {
      this.betaTag = isBackgroundEnabled();
    });
```

In `beforeUnmount()`, add as the first lines:

```ts
    if (this.releaseFlagListener) {
      this.releaseFlagListener();
    }
```

- [ ] **Step 4: Remove the beta banner from `src/components/Scrobblify.vue`**

1. In the `<v-alert v-if="banner" …>` opening tag, delete these two lines:

   ```html
      :variant="banner === 'beta' ? 'tonal' : undefined"
      :density="banner === 'beta' ? 'compact' : undefined"
   ```

2. Delete this whole block (just before `</v-alert>`):

   ```html
      <!--
        Sticky opt-in, so it needs to be visible and reversible: a flag the user
        cannot see is one they cannot report a bug against or switch off. Last
        in line, so it only shows when nothing more useful does.
      -->
      <template v-else-if="banner === 'beta'">
        Background scrobbling (beta) is switched on for this browser.
        <a :href="betaOffHref">Switch it off</a>.
      </template>
   ```

3. In `data()`, delete `betaOptedIn: false,`.

4. In `mounted()`, delete the comment and line that set it:

   ```ts
    /*
      Before anything else, because it is pure local state and the handoff
      return below can navigate away. Only the *offer* reads it; the recovery
      paths further down deliberately do not, so a browser that arrives here
      without the flag still learns about a job it left running.
    */
    this.betaOptedIn = background.consumeBetaParam();
   ```

   (`App.vue`'s `created()` now does this before this component mounts.)

5. In the `banner()` computed: change the return type to
   `'outage' | 'job' | 'signIn' | 'resume' | 'notice' | null`, delete the line
   `if (this.betaOptedIn) { return 'beta'; }`, and delete the doc-comment line
   `*   beta   — the opt-in reminder, only when nothing else needs saying.`

6. In `bannerType()`, change

   ```ts
        case 'resume':
        case 'beta': return 'info';
   ```

   to

   ```ts
        case 'resume': return 'info';
   ```

7. Delete the whole `betaOffHref()` computed and its doc comment ("An opt-out link for the current page…").

- [ ] **Step 5: Run the tests to see them pass**

Run: `npx playwright test -c playwright.unreachable-worker.config.ts -g "BETA tag"`
Expected: 4 passed.

Run: `npx playwright test -c playwright.unreachable-worker.config.ts`
Expected: all pass (the existing "rollout flag offers it without the opt-in" test asserts the banner is absent, which is now always true).

Run: `$env:PORT=<PORT>; npx playwright test tests/scrobblify.spec.ts -g "Home Page"`
Expected: PASS.

- [ ] **Step 6: Lint and commit**

Run: `npm run lint:check`
Expected: no errors.

```powershell
git add src/App.vue src/components/Scrobblify.vue tests/scrobblify.spec.ts tests/unreachable-worker/unreachable-worker.spec.ts
git commit -m "Show a BETA tag in the header instead of the beta banner" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Remember the handed-over import id

Home needs the import id of a queue this browser handed to the worker, to ask the public `/scrobblify/import/:id` route for its progress. Today the id is lost when the handover clears the saved queue.

**Files:**
- Modify: `src/services/BackgroundScrobbling.ts`
- Modify: `src/services/BackgroundHandoff.ts`
- Modify: `src/components/Scrobblify.vue`

This is covered by Task 4's server-job test; there is no separate test.

- [ ] **Step 1: Add the record to `src/services/BackgroundScrobbling.ts`**

Directly after the `setBetaOptIn` function, add:

```ts
const HANDED_OVER_IMPORT_KEY = 'scrobblify.background.handedOverImport';

/**
 * The import id of the queue this browser last handed to the worker.
 *
 * Display only: Home uses it to show a running job's progress through the
 * public `/scrobblify/import/:id` route after the local queue has been
 * cleared. It is deliberately **not** handover evidence for
 * `mayScrobbleWithoutAuthority`; the ownership records are.
 */
export function recordHandedOverImport(importId: string): void {
  if (!importId) {
    return;
  }
  try {
    window.localStorage.setItem(HANDED_OVER_IMPORT_KEY, importId);
  } catch {
    // Private browsing. Home just won't show the job's progress.
  }
}

export function handedOverImport(): string {
  try {
    return window.localStorage.getItem(HANDED_OVER_IMPORT_KEY) || '';
  } catch {
    return '';
  }
}

export function clearHandedOverImport(): void {
  try {
    window.localStorage.removeItem(HANDED_OVER_IMPORT_KEY);
  } catch {
    // Nothing to clear.
  }
}
```

- [ ] **Step 2: Write it when a handover goes live (`src/services/BackgroundHandoff.ts`, `completeHandoff`)**

After `api.setQueueOwner({ owner: 'server', id: outcome.jobId });` add:

```ts
    api.recordHandedOverImport(state.importId || '');
```

After `api.setQueueOwner({ owner: 'server', id: jobId });` (inside `if (active === true) {`) add:

```ts
    api.recordHandedOverImport(state.importId || '');
```

- [ ] **Step 3: Clear it after a confirmed take-back (`src/components/Scrobblify.vue`, `takeBackProgress`)**

After `background.clearHandoffLineage(carriedLineage.ranges, carriedLineage.knownFromSec);` add:

```ts
        background.clearHandedOverImport();
```

- [ ] **Step 4: Lint and commit**

Run: `npm run lint:check`
Expected: no errors.

```powershell
git add src/services/BackgroundScrobbling.ts src/services/BackgroundHandoff.ts src/components/Scrobblify.vue
git commit -m "Remember the import id this browser handed to the worker" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: `ReturningVisitor` service

**Files:**
- Create: `src/services/ReturningVisitor.ts`

Exercised through Home's tests in Tasks 4 and 5.

- [ ] **Step 1: Create `src/services/ReturningVisitor.ts`**

```ts
import LastFm from '@/api/LastFm';
import StateManager from '@/services/StateManager';
import * as background from '@/services/BackgroundScrobbling';

/** Which Home page a visitor gets. */
export type ReturningState =
  | { kind: 'none' }
  | { kind: 'saved'; username: string | null; signedIn: boolean; done: number; total: number }
  | { kind: 'server_job'; username: string | null; done: number; total: number }
  | { kind: 'username_only'; username: string };

const ENDED_STATES = ['completed', 'failed', 'cancelled', 'expired', 'reaped'];

export function progressLabel(done: number, total: number): string {
  const pct = total > 0 ? Math.floor((100 * done) / total) : 0;
  return `${done.toLocaleString()} / ${total.toLocaleString()} · ${pct}%`;
}

export function progressPct(done: number, total: number): number {
  return total > 0 ? Math.min(100, (100 * done) / total) : 0;
}

/**
 * Decides the Home state, most specific first: a job this browser handed to
 * the worker, then saved progress, then a remembered username.
 *
 * Never throws: an unreadable IndexedDB or an unreachable worker just means
 * less is known, and the visitor gets a simpler page.
 */
export async function detectReturning(
  api: LastFm,
  stateManager: StateManager,
): Promise<ReturningState> {
  const username = api.getUserName();

  /*
    Only a *live* job (sending, paused or stopped by errors, all of which keep
    their place) is shown as running. One that is signed out or on hold falls
    through to the plain card; the status page on /scrobble explains it. A
    record the server doesn't know, or whose job has ended, is dropped.
  */
  const importId = background.handedOverImport(username);
  if (importId) {
    const status = await background.importStatus(importId);
    if (status && status.live) {
      return {
        kind: 'server_job', username, done: status.scrobbledCount, total: status.totalTracks,
      };
    }
    if (status && (!status.known || ENDED_STATES.includes(status.state || ''))) {
      background.clearHandedOverImport();
    }
  }

  let saved = null;
  try {
    saved = await stateManager.loadState();
  } catch {
    saved = null;
  }
  if (saved && saved.totalTracks > 0) {
    const total = saved.originalTotalTracks || saved.totalTracks;
    const done = typeof saved.originalSucceededCount === 'number'
      ? saved.originalSucceededCount
      : saved.completedIndices.length;
    return {
      kind: 'saved', username, signedIn: api.isAuthenticated(), done, total,
    };
  }

  if (username) {
    return { kind: 'username_only', username };
  }
  return { kind: 'none' };
}
```

- [ ] **Step 2: Lint and commit**

Run: `npm run lint:check`
Expected: no errors.

```powershell
git add src/services/ReturningVisitor.ts
git commit -m "Add ReturningVisitor to pick the Home page state" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Home first visit and "get your history"

**Files:**
- Create: `src/components/home/HomeGetExport.vue`
- Rewrite: `src/views/Home.vue`
- Test: `tests/scrobblify.spec.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/scrobblify.spec.ts`, replace the existing test `renders home page with instructions` with these (inside `test.describe('Home Page', …)`):

```ts
  test('a first visit offers two equal choices and a way back in', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await expect(page.locator('h1')).toHaveText('Retroactively scrobble Spotify plays to last.fm');
    await expect(page.locator('text=Already got your streaming history zip?')).toBeVisible();
    await expect(page.locator("text=Don't have it yet?")).toBeVisible();
    await expect(page.locator('text=Already scrobbling on scrobblify?')).toBeVisible();

    await page.locator('.home-card:has-text("Already got your") button:has-text("Start")').click();
    await expect(page).toHaveURL(/#\/scrobble/);
    await expect.poll(() => events).toContainEqual({ name: 'home_choice', props: { choice: 'have_export' } });
  });

  test('"Show me how" swaps the choices for the steps, and Back brings them back', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await page.locator('button:has-text("Show me how")').click();

    await expect(page.locator('h2:has-text("Get your history from Spotify")')).toBeVisible();
    await expect(page.locator('.get-export li')).toHaveCount(3);
    await expect(page.locator('.get-export a[href="https://www.spotify.com/account/privacy/"]')).toBeVisible();
    await expect(page.locator('.home-card')).toHaveCount(0);
    await expect.poll(() => events).toContainEqual({ name: 'home_choice', props: { choice: 'get_export' } });

    await page.locator('.get-export-back').click();
    await expect(page.locator('.home-card')).toHaveCount(2);
  });

  test('"Re-connect to last.fm" opens the scrobble page', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await page.locator('a:has-text("Re-connect to last.fm")').click();
    await expect(page).toHaveURL(/#\/scrobble/);
    await expect.poll(() => events).toContainEqual({ name: 'home_choice', props: { choice: 'resume' } });
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `$env:PORT=<PORT>; npx playwright test tests/scrobblify.spec.ts -g "Home Page"`
Expected: the three new tests FAIL (old Home has none of this text).

- [ ] **Step 3: Create `src/components/home/HomeGetExport.vue`**

```vue
<template>
  <div class="get-export">
    <a href="#" class="get-export-back" @click.prevent="$emit('back')">← Back</a>
    <h2>Get your history from Spotify</h2>
    <ol>
      <li>
        Go to
        <a
          href="https://www.spotify.com/account/privacy/"
          target="_blank"
          rel="noopener noreferrer"
        >your Spotify privacy settings</a>
        and request <strong>Extended streaming history</strong> (not "Account data").
      </li>
      <li>Wait for Spotify's email. Usually a few days.</li>
      <li>Download the ZIP and upload it in <router-link to="/scrobble">scrobble</router-link></li>
    </ol>
  </div>
</template>

<style>
.get-export {
  text-align: left;
  max-width: 520px;
  margin: 0 auto;
}

.get-export h2 {
  margin: 12px 0;
}

.get-export li {
  margin-bottom: 10px;
}
</style>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'HomeGetExport',
  emits: ['back'],
});
</script>
```

- [ ] **Step 4: Rewrite `src/views/Home.vue`**

(The returning card is wired in Task 5; this version already reserves its place.)

```vue
<template>
  <div class="home">
    <h1 class="home-title">Retroactively scrobble Spotify plays to last.fm</h1>

    <home-get-export v-if="gettingExport" @back="gettingExport = false" />

    <template v-else-if="ready && returning.kind === 'none'">
      <div class="home-cards">
        <v-card class="home-card">
          <v-card-title class="text-wrap">Already got your streaming history zip?</v-card-title>
          <v-card-actions>
            <v-btn color="primary" variant="flat" block @click="go('have_export')">Start</v-btn>
          </v-card-actions>
        </v-card>
        <v-card class="home-card">
          <v-card-title class="text-wrap">Don't have it yet?</v-card-title>
          <v-card-actions>
            <v-btn color="primary" variant="flat" block @click="showGetExport">Show me how</v-btn>
          </v-card-actions>
        </v-card>
      </div>
      <p class="home-already">
        Already scrobbling on scrobblify?
        <a href="#" @click.prevent="go('resume')">Re-connect to last.fm</a>
      </p>
    </template>
  </div>
</template>

<style>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 5%;
}

.home-title {
  margin: 8px 0 24px;
}

.home-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 600px) {
  .home-cards {
    grid-template-columns: 1fr;
  }
}

.home-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.home-already {
  margin-top: 24px;
}
</style>

<script lang="ts">
import { defineComponent, markRaw } from 'vue';
import LastFm from '@/api/LastFm';
import HomeGetExport from '@/components/home/HomeGetExport.vue';
import StateManager from '@/services/StateManager';
import { detectReturning, ReturningState } from '@/services/ReturningVisitor';
import { trackEvent } from '@/services/Analytics';

type HomeChoice = 'have_export' | 'get_export' | 'resume';

export default defineComponent({
  components: { 'home-get-export': HomeGetExport },
  data() {
    return {
      // Nothing renders until the returning check settles, so a returning
      // visitor never sees the first-visit page flash first.
      ready: false,
      gettingExport: false,
      returning: { kind: 'none' } as ReturningState,
      stateManager: markRaw(new StateManager()),
    };
  },
  async mounted() {
    await this.refreshReturning();
  },
  methods: {
    async refreshReturning() {
      const api = this.$store.state.lfmApi as LastFm;
      this.returning = await detectReturning(api, this.stateManager);
      this.ready = true;
    },
    go(choice: HomeChoice) {
      trackEvent('home_choice', { choice });
      this.$router.push('/scrobble');
    },
    showGetExport() {
      trackEvent('home_choice', { choice: 'get_export' });
      this.gettingExport = true;
    },
  },
});
</script>
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `$env:PORT=<PORT>; npx playwright test tests/scrobblify.spec.ts -g "Home Page"`
Expected: all pass, including `has navigation links` and the footer test.

- [ ] **Step 6: Lint and commit**

Run: `npm run lint:check`
Expected: no errors.

```powershell
git add src/components/home/HomeGetExport.vue src/views/Home.vue tests/scrobblify.spec.ts
git commit -m "Rewrite Home as two choices plus the get-your-history steps" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Returning-visitor card

**Files:**
- Create: `src/components/home/HomeReturning.vue`
- Modify: `src/views/Home.vue`
- Test: `tests/scrobblify.spec.ts`, `tests/unreachable-worker/unreachable-worker.spec.ts`

- [ ] **Step 1: Write the failing tests (default build)**

`seedSavedState` is declared further down `tests/scrobblify.spec.ts` (module scope, so it is usable here). Add to `test.describe('Home Page', …)`:

```ts
  const SAVED = {
    userName: 'testuser',
    totalTracks: 5,
    completedIndices: [0, 1, 2],
    failedIndices: [],
    tracks: [1, 2, 3, 4, 5].map((n) => ({
      track: `Track ${n}`, artist: `Artist ${n}`, album: `Album ${n}`, timestamp: Date.UTC(2024, 0, n),
    })),
    originalTotalTracks: 5,
    originalSucceededCount: 3,
    sendTimestamps: [],
    burstCount: 0,
    dailyCount: 0,
    dailyCountDate: new Date().toISOString().split('T')[0],
    savedAt: new Date().toISOString(),
  };

  test('a visitor with saved progress gets a welcome-back card instead', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await page.evaluate(() => localStorage.setItem('scrobblifyLfmUserName', 'testuser'));
    await seedSavedState(page, SAVED);
    await page.reload();

    const card = page.locator('.returning-card');
    await expect(card.locator('.v-card-title')).toHaveText('Welcome back, testuser');
    await expect(card.locator('.returning-bar')).toContainText('3 / 5 · 60%');
    await expect(page.locator('.home-card')).toHaveCount(0);
    await expect.poll(() => events).toContainEqual({ name: 'home_returning_shown', props: { state: 'saved_signed_out' } });

    await card.locator('button:has-text("Continue")').click();
    await expect(page).toHaveURL(/#\/scrobble/);
  });

  test('a signed-in visitor with saved progress is reported as such', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await mockLastFmAuth(page);
    await seedSavedState(page, SAVED);
    await page.reload();
    await expect(page.locator('.returning-card')).toBeVisible();
    await expect.poll(() => events).toContainEqual({ name: 'home_returning_shown', props: { state: 'saved_signed_in' } });
  });

  test('a remembered username with nothing saved is offered an upload, and "Not you?" forgets it', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await page.evaluate(() => localStorage.setItem('scrobblifyLfmUserName', 'testuser'));
    await page.reload();

    const card = page.locator('.returning-card');
    await expect(card.locator('.v-card-title')).toHaveText('Welcome back, testuser');
    await expect(card.locator('.returning-bar')).toHaveCount(0);
    await expect(card.locator('button:has-text("Upload Spotify zip")')).toBeVisible();
    await expect.poll(() => events).toContainEqual({ name: 'home_returning_shown', props: { state: 'username_only' } });

    await card.locator('a:has-text("Not you?")').click();
    await expect(page.locator('.home-card')).toHaveCount(2);
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmUserName'))).toBeNull();
  });

  test('"Show me how" on the returning card opens the steps', async ({ page }) => {
    await page.goto('/#/');
    await page.evaluate(() => localStorage.setItem('scrobblifyLfmUserName', 'testuser'));
    await page.reload();
    await page.locator('.returning-card a:has-text("Show me how")').click();
    await expect(page.locator('h2:has-text("Get your history from Spotify")')).toBeVisible();
  });
```

- [ ] **Step 2: Write the failing test (worker-configured build)**

Append to `tests/unreachable-worker/unreachable-worker.spec.ts`:

```ts
test.describe('Home with a job on the server', () => {
  test('shows the job\'s progress from the handed-over import id', async ({ page }) => {
    const importId = 'c1c2c3c4c5c6c7c8c9c0d1d2d3d4d5d6';
    await page.route(WORKER, async (route: Route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === `/scrobblify/import/${importId}`) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true, known: true, live: true, state: 'active', cursor: 1200, scrobbledCount: 1200, totalTracks: 4000,
          }),
        });
        return;
      }
      await route.abort('internetdisconnected');
    });
    await page.goto('/#/');
    await page.evaluate((id) => {
      localStorage.setItem('scrobblifyLfmUserName', 'testuser');
      localStorage.setItem('scrobblify.background.handedOverImport', JSON.stringify({ importId: id, username: 'testuser' }));
    }, importId);
    await page.reload();

    const card = page.locator('.returning-card');
    await expect(card.locator('.returning-bar')).toContainText('1,200 / 4,000 · 30%');
    await expect(card).toContainText('Scrobbling in the background!');
    await expect(card.locator('button')).toHaveCount(0);
  });

  test('a finished job falls back to the plain welcome-back card and forgets the id', async ({ page }) => {
    const importId = 'e1e2e3e4e5e6e7e8e9e0f1f2f3f4f5f6';
    await page.route(WORKER, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true, known: true, live: false, state: 'completed', cursor: 4000, scrobbledCount: 4000, totalTracks: 4000,
        }),
      });
    });
    await page.goto('/#/');
    await page.evaluate((id) => {
      localStorage.setItem('scrobblifyLfmUserName', 'testuser');
      localStorage.setItem('scrobblify.background.handedOverImport', JSON.stringify({ importId: id, username: 'testuser' }));
    }, importId);
    await page.reload();

    await expect(page.locator('.returning-card button:has-text("Upload Spotify zip")')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('scrobblify.background.handedOverImport'))).toBeNull();
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `$env:PORT=<PORT>; npx playwright test tests/scrobblify.spec.ts -g "Home Page"`
Expected: the four new tests FAIL (no `.returning-card`).

Run: `npx playwright test -c playwright.unreachable-worker.config.ts -g "Home with a job"`
Expected: both FAIL.

- [ ] **Step 4: Create `src/components/home/HomeReturning.vue`**

```vue
<template>
  <v-card class="returning-card mx-auto" max-width="440">
    <v-card-title class="text-wrap">{{ title }}</v-card-title>
    <v-card-text v-if="hasProgress || state.kind === 'server_job'">
      <v-progress-linear
        v-if="hasProgress"
        class="returning-bar"
        :model-value="pct"
        color="primary"
        height="22"
        rounded
      >
        <span class="returning-bar-label">{{ barLabel }}</span>
      </v-progress-linear>
      <p v-if="state.kind === 'server_job'" class="mt-3 mb-0">Scrobbling in the background!</p>
    </v-card-text>

    <v-card-actions v-if="state.kind === 'saved'" class="flex-column">
      <v-btn color="primary" variant="flat" block @click="$emit('continue')">Continue</v-btn>
      <div class="returning-links mt-2">
        <a href="#" @click.prevent="$emit('not-you')">Not you?</a>
        ·
        <a href="#" @click.prevent="$emit('start-over')">Start over</a>
      </div>
    </v-card-actions>

    <v-card-actions v-else-if="state.kind === 'username_only'" class="flex-column">
      <v-btn color="primary" variant="flat" block @click="$emit('upload')">Upload Spotify zip</v-btn>
      <div class="returning-links mt-2">
        <a href="#" @click.prevent="$emit('not-you')">Not you?</a>
        ·
        <a href="#" @click.prevent="$emit('show-get-export')">Show me how</a>
      </div>
    </v-card-actions>
  </v-card>
</template>

<style>
.returning-bar-label {
  font-size: 12px;
  font-weight: 700;
}

.returning-links {
  font-size: 13px;
}
</style>

<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { progressLabel, progressPct, ReturningState } from '@/services/ReturningVisitor';

export default defineComponent({
  name: 'HomeReturning',
  props: {
    state: { type: Object as PropType<ReturningState>, required: true },
  },
  emits: ['continue', 'not-you', 'start-over', 'upload', 'show-get-export'],
  computed: {
    title(): string {
      const s = this.state;
      const name = s.kind === 'none' ? null : s.username;
      return name ? `Welcome back, ${name}` : 'Welcome back';
    },
    hasProgress(): boolean {
      return (this.state.kind === 'saved' || this.state.kind === 'server_job') && this.state.total > 0;
    },
    pct(): number {
      const s = this.state;
      return s.kind === 'saved' || s.kind === 'server_job' ? progressPct(s.done, s.total) : 0;
    },
    barLabel(): string {
      const s = this.state;
      return s.kind === 'saved' || s.kind === 'server_job' ? progressLabel(s.done, s.total) : '';
    },
  },
});
</script>
```

- [ ] **Step 5: Wire it into `src/views/Home.vue`**

In the template, between `<home-get-export … />` and `<template v-else-if="ready && returning.kind === 'none'">`, add:

```html
    <home-returning
      v-else-if="ready && returning.kind !== 'none'"
      :state="returning"
      @continue="openScrobble"
      @start-over="openScrobble"
      @upload="openScrobble"
      @not-you="notYou"
      @show-get-export="showGetExport"
    />
```

In the script, add the imports:

```ts
import HomeReturning from '@/components/home/HomeReturning.vue';
import { resetUser, trackEvent } from '@/services/Analytics';
```

(replacing the existing `import { trackEvent } from '@/services/Analytics';`), register the component:

```ts
  components: { 'home-get-export': HomeGetExport, 'home-returning': HomeReturning },
```

replace `refreshReturning` with:

```ts
    async refreshReturning() {
      const api = this.$store.state.lfmApi as LastFm;
      this.returning = await detectReturning(api, this.stateManager);
      this.ready = true;
      const r = this.returning;
      if (r.kind !== 'none') {
        let state: string = r.kind;
        if (r.kind === 'saved') {
          state = r.signedIn ? 'saved_signed_in' : 'saved_signed_out';
        }
        trackEvent('home_returning_shown', { state });
      }
    },
```

and add these methods:

```ts
    // Until sign-in moves after choosing (Plan 3), /scrobble's own sign-in
    // step and resume banner take it from here.
    openScrobble() {
      this.$router.push('/scrobble');
    },
    async notYou() {
      (this.$store.state.lfmApi as LastFm).clearUser();
      resetUser();
      trackEvent('user_logged_out');
      await this.refreshReturning();
    },
```

- [ ] **Step 6: Run the tests to see them pass**

Run: `$env:PORT=<PORT>; npx playwright test tests/scrobblify.spec.ts -g "Home Page"`
Expected: all pass.

Run: `npx playwright test -c playwright.unreachable-worker.config.ts -g "Home with a job"`
Expected: 2 passed.

- [ ] **Step 7: Lint and commit**

Run: `npm run lint:check`
Expected: no errors.

```powershell
git add src/components/home/HomeReturning.vue src/views/Home.vue tests/scrobblify.spec.ts tests/unreachable-worker/unreachable-worker.spec.ts
git commit -m "Welcome returning visitors back with their progress" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: About with a collapsible FAQ

**Files:**
- Rewrite: `src/views/About.vue`
- Test: `tests/scrobblify.spec.ts`

- [ ] **Step 1: Write the failing tests**

In `test.describe('About Page', …)`, in both chunk-reload tests change

```ts
    await expect(page.locator('.about h1').first()).toHaveText('What is Scrobblify?', { timeout: 10000 });
```

to

```ts
    await expect(page.locator('.about h1').first()).toHaveText('About', { timeout: 10000 });
```

(only the first chunk test has this line), and add:

```ts
  test('answers questions in a collapsible FAQ, with ListenBrainz one click away', async ({ page }) => {
    const events = captureEvents(page);
    await page.context().route('https://listenbrainz.org/**', (route) => route.fulfill({ status: 200, body: '' }));
    await page.goto('/#/about');

    await expect(page.locator('.about')).toContainText('buy me a coffee');
    await expect(page.locator('.about-faq .v-expansion-panel')).toHaveCount(4);
    const dates = page.locator('.about-faq .v-expansion-panel:has-text("Why do old plays get today\'s date?")');
    await expect(dates.locator('.v-expansion-panel-text__wrapper')).toBeHidden();
    await dates.locator('.v-expansion-panel-title').click();
    await expect(dates).toContainText('Last.fm only accepts plays from the last two weeks');

    const popup = page.waitForEvent('popup');
    await dates.locator('a:has-text("ListenBrainz")').click();
    await popup;
    await expect.poll(() => events).toContainEqual({ name: 'listenbrainz_clicked', props: { source: 'about' } });

    await expect(page.locator('.about h2:has-text("Who built Scrobblify?")')).toBeVisible();
    await expect(page.locator('.about h2:has-text("Contribute")')).toBeVisible();
    await expect(page.locator('text=Support Scrobblify')).toHaveCount(0);
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `$env:PORT=<PORT>; npx playwright test tests/scrobblify.spec.ts -g "About Page"`
Expected: the FAQ test and the first chunk test FAIL.

- [ ] **Step 3: Rewrite `src/views/About.vue`**

```vue
<template>
  <div class="about">
    <h1>About</h1>
    <p>
      Scrobblify is a free tool that scrobbles your Spotify listening history to last.fm.
      I built it to help out fellow music data nerds! If you want to say thank you, you can
      <a href="https://buymeacoffee.com/nikosavas" target="_blank" rel="noopener noreferrer">buy me a coffee</a> :)
    </p>

    <v-expansion-panels class="about-faq my-6" variant="accordion">
      <v-expansion-panel title="Why do old plays get today's date?">
        <v-expansion-panel-text>
          Last.fm only accepts plays from the last two weeks with their real date (probably to avoid
          overloading their servers/gaming the system). If you have thoughts about this, please let
          them know! You won't run into this issue on
          <a
            href="https://listenbrainz.org/settings/import/"
            target="_blank"
            rel="noopener noreferrer"
            @click="listenBrainzClicked"
          >ListenBrainz</a>
          so I recommend checking that out if you want fully accurate data.
        </v-expansion-panel-text>
      </v-expansion-panel>
      <v-expansion-panel title="Why does it take so long?">
        <v-expansion-panel-text>
          Last.fm has a maximum 750 scrobbles per day per user, so scrobblify has to go that slowly.
        </v-expansion-panel-text>
      </v-expansion-panel>
      <v-expansion-panel title="Will it add duplicates?">
        <v-expansion-panel-text>
          Yes, the idea of scrobblify is that you get the correct <strong>counts</strong> of each track
          listen, so it'll scrobble one time for every time you listened to a song on spotify. Plays
          already on Last.fm are skipped if you tick "Check for duplicates" (last two weeks only).
        </v-expansion-panel-text>
      </v-expansion-panel>
      <v-expansion-panel title="Where does my data go?">
        <v-expansion-panel-text>
          Your zip file is never uploaded and stays on your browser. If you scrobble using the
          background service, the plays get uploaded there associated with your username. There is an
          option to do all the scrobbling locally in which case nothing is stored on Scrobblify's
          server. Scrobblify does log usage and errors so I can fix bugs.
        </v-expansion-panel-text>
      </v-expansion-panel>
    </v-expansion-panels>

    <h2>Who built Scrobblify?</h2>
    <p>
      Scrobblify is written and maintained by <a href="https://savas.ca/">Niko Savas</a>.
      Swing by my <a href="https://www.last.fm/user/nikos_">Last.fm profile</a> and say hi!
    </p>

    <h2>Contribute</h2>
    <p>
      If you're a developer who wants a feature or wants to help improve this tool, please swing by
      the <a href="https://github.com/taurheim/scrobblify">GitHub repository</a> and submit a pull request!
    </p>
  </div>
</template>

<style>
.about {
  max-width: 800px;
  margin: 0 auto;
  text-align: left;
  padding: 0 5%;
}

.about h2 {
  margin-top: 16px;
}
</style>

<script lang="ts">
import { defineComponent } from 'vue';
import { trackEvent } from '@/services/Analytics';

export default defineComponent({
  methods: {
    listenBrainzClicked() {
      trackEvent('listenbrainz_clicked', { source: 'about' });
    },
  },
});
</script>
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `$env:PORT=<PORT>; npx playwright test tests/scrobblify.spec.ts -g "About Page"`
Expected: all pass.

- [ ] **Step 5: Lint and commit**

Run: `npm run lint:check`
Expected: no errors.

```powershell
git add src/views/About.vue tests/scrobblify.spec.ts
git commit -m "Rewrite About with a collapsible FAQ" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Document the changes in `AGENTS.md`

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Funnel events.** In "### Funnel events", after the paragraph ending `"Old builds keep running" above).`, add:

```markdown
Home emits `home_choice` (`choice`: `have_export`, `get_export` or `resume`;
`resume` is the "Already scrobbling on scrobblify?" link) on first visits, and
`home_returning_shown` (`state`: `saved_signed_in`, `saved_signed_out`,
`server_job` or `username_only`) when it shows the welcome-back card instead,
which it does whenever this browser has a remembered username, saved progress,
or a handed-over import whose job hasn't finished. Both since the guided-home
release; until sign-in moves after choosing, every Home button opens
`/scrobble`.
```

- [ ] **Step 2: ListenBrainz sources.** Replace

```markdown
(which also closes the gate), `gate_text` (the inline link) or `home` (the Home
page; no other properties).
```

with

```markdown
(which also closes the gate), `gate_text` (the inline link) or `about` (the About
page's FAQ; no other properties). `home` was the old Home page's link, which the
guided-home release removed.
```

- [ ] **Step 3: Home and About copy.** Replace

```markdown
Home and About only know the opt-in or flag (`isBackgroundEnabled()`, read
once on mount, so the flag counts there only once it has loaded), not live
capacity. New copy along those lines needs the same branch.
```

with

```markdown
Home and About no longer have background-specific copy; outside `/scrobble`
the only beta surface is the header's BETA tag.
```

- [ ] **Step 4: Beta gate.** Replace

```markdown
Only an explicit opt-in shows the info banner with a switch-off link (when no
other banner is showing), and only the explicit opt-in counts in
```

with

```markdown
`App.vue` applies `?beta=` once per page load (`consumeBetaParam`), so an invite
link works on any page, and shows a **BETA** tag in the header whenever
`isBackgroundEnabled()` (re-read on `onFeatureFlags`). The old "switched on for
this browser — Switch it off" banner is gone; `?beta=0` still opts out. Only the
explicit opt-in counts in
```

and after the paragraph that sentence belongs to, add:

```markdown
`scrobblify.background.handedOverImport` (localStorage) holds the import id and Last.fm username of
the queue this browser last handed over, written when a handover goes live and
cleared after a confirmed take-back or once the job is seen finished. Home uses
it with the public `/scrobblify/import/:id` route to show a running job's
progress, only to the same Last.fm user, and only while the job is live (a signed-out or on-hold job gets the plain card). It is display-only and deliberately **not** handover evidence.
```

- [ ] **Step 5: Commit**

```powershell
git add AGENTS.md
git commit -m "Document the guided Home, BETA tag and handed-over import record" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Full verification

- [ ] **Step 1: Lint**

Run: `npm run lint:check`
Expected: 0 errors.

- [ ] **Step 2: Confirm the port is yours, then run the whole default suite**

```powershell
Get-NetTCPConnection -LocalPort <PORT> -State Listen -ErrorAction SilentlyContinue
```

If something is listening, check it is this worktree's server (`AGENTS.md`, "Running the tests") or pick another port.

Run: `$env:PORT=<PORT>; npx playwright test`
Expected: all pass.

- [ ] **Step 3: Run the worker-configured suite**

Run: `npx playwright test -c playwright.unreachable-worker.config.ts`
Expected: all pass.

- [ ] **Step 4: Production build (checks `.htaccess` and type errors)**

Run: `npm run build`
Expected: completes; `dist/.htaccess` exists.

- [ ] **Step 5: Look at it**

Run `$env:PORT=<PORT>; npm run dev:mock` and open the printed URL. Check: first visit (both cards, "Show me how" and Back), `?beta=1` shows the tag, About's FAQ opens. Seed `localStorage.scrobblifyLfmUserName = 'someone'` in devtools and reload to see the returning card. Stop the server afterwards.
