# Sign In After Choosing Implementation Plan (Plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship spec PR 3 of `docs/superpowers/specs/2026-11-20-guided-home-and-background-design.md` (sections 4 and 5 "The beta flag before sign-in"): `/scrobble` no longer starts with a Last.fm sign-in step. Users upload and choose first and sign in only when they start sending; the beta flag works before sign-in; and the beta banner (with a feedback line) shows on every page.

**Architecture:** The stepper keeps its internal step numbers (2 Upload, 3 Choose, 4 Send, 5 Done) so telemetry stays comparable, but step 1 disappears from the header and `currentStep` starts at 2. `AuthenticateStep` becomes a headless token handler above the stepper: it still exchanges a `?token=` on mount and still emits `complete`, but renders only a spinner, the expired-token prompt or an error. A new `src/services/SignInIntent.ts` records *why* the browser is going to Last.fm (in `sessionStorage`, which survives the same-tab redirect) and starts the redirect; `Scrobblify.vue`'s `onAuthenticated` reads the intent on return and carries on. A fresh selection made while signed out is saved to IndexedDB as an ordinary `ScrobbleState` (0 completed) before the redirect and restored through `restoreFromState` afterwards.

**Tech Stack:** Vue 3 (Options API), Vuetify 4, Vuex, TypeScript, Playwright.

**Scope decisions (made while planning; recorded in the spec in Task 8):**

- **Browser sign-in only.** The spec's "server path signs in to the worker application only" needs worker changes: `/scrobblify/handoff/preflight` and `/scrobblify/auth/signin` both require a username today and check Last.fm's answer against it (`worker/src/handoff.ts:242-258`, `worker/src/api.ts:433-495`). That moves to Plan 3 with the server-choice dialog. Until then, beta users sign in to the browser application and get today's background offer.
- **Already signed in = unchanged.** A returning user with a stored session never sees a sign-in; the duplicate check still runs during upload, as today.
- **Signed out + "Check for duplicates":** the check is deferred until after sign-in, then run on the chosen queue; skipped plays are reported in one line.
- **No auto-start.** After the Last.fm round trip the user lands on Send and presses **Scrobble**, as after any resume. The server-authority check has to answer first anyway.
- **"Re-connect to last.fm"** on Home becomes a browser sign-in that lands on `/scrobble`, where the job banner or resume banner takes over. Plan 3 switches it to a worker sign-in.

**Copy:** use exactly the strings below. Strings marked *(draft)* are new and listed in the strings file for the owner to rewrite; do not invent others.

---

## Before you start

Read `AGENTS.md`: "Bugs you find along the way", "Local servers and ports", "Running the tests", "Background scrobbling beta gate".

- Default Playwright config: **always** `$env:PORT=8644; npx playwright test …` in the same command, after confirming port 8644 is free or owned by this checkout.
- Worker-configured config: `npx playwright test -c playwright.unreachable-worker.config.ts …` (own server on 8471).
- `npm run lint:check`, `npx tsc --noEmit -p .`.
- Never stage `package-lock.json`. Trailer: `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`.

**How Playwright signs in without Last.fm:** the default build links to `https://www.last.fm/api/auth/?api_key=…&cb=…`. Route that URL to the app's callback with a fresh token; `tests/lastfmMock.js`'s `interceptLastFm` already answers `auth.getSession` with user `testuser`:

```ts
async function routeLastFmSignIn(page: Page) {
  await page.route('https://www.last.fm/api/auth/**', (route) => route.fulfill({
    status: 302,
    headers: { location: `/#/scrobble?token=t-${Math.random().toString(16).slice(2, 10)}` },
  }));
}
```

(Add it once, at module scope in `tests/scrobblify.spec.ts`, in Task 3; later tasks reuse it.)

## File map

| File | Change | Responsibility |
| --- | --- | --- |
| `src/services/Analytics.ts` | Modify | Flags honoured before identification; `isIdentified()` |
| `src/services/BackgroundScrobbling.ts` | Modify | `offer_source: flag_anonymous` |
| `src/App.vue` | Modify | Beta feedback banner on every page |
| `src/services/SignInIntent.ts` | Create | Why we went to Last.fm; start the redirect |
| `src/components/AuthenticateStep.vue` | Modify | Headless token handler |
| `src/components/Scrobblify.vue` | Modify | No step 1; sign-in on demand; intents on return; deferred duplicate check |
| `src/components/UploadStep.vue` | Modify | Defer the duplicate check when signed out |
| `src/scrobblify.ts` | Modify | Duplicate filter for a chosen queue |
| `src/store.ts` | Modify | `deferredDuplicateCheck` |
| `src/views/Home.vue` | Modify | Continue / Re-connect start sign-in |
| `tests/scrobblify.spec.ts`, `tests/unreachable-worker/unreachable-worker.spec.ts` | Modify | Tests |
| `AGENTS.md`, spec, strings | Modify | Docs |

---

### Task 1: Beta flag before sign-in

**Files:** Modify `src/services/Analytics.ts`, `src/services/BackgroundScrobbling.ts`.

There is no Playwright coverage possible for PostHog itself (nothing is captured from localhost); the local `scrobblify.flags` override path keeps working and is covered by existing tests.

- [ ] **Step 1: `isFeatureEnabled` stops requiring identification.** In `src/services/Analytics.ts` replace the doc comment and body of `isFeatureEnabled` with:

```ts
/**
 * Whether a PostHog feature flag is on. False until flags have loaded, when
 * analytics is off, and when PostHog is blocked, so a flag can only ever *add*
 * a feature to the default experience.
 *
 * Honoured before sign-in too, because the server choice now comes before
 * sign-in. Before `identifyUser`, PostHog buckets on a random per-browser id;
 * after it, on the Last.fm username, which is what makes a rollout stick to a
 * user across browsers. The two can disagree for a brand-new user's first
 * offer; `isIdentified()` lets callers tell them apart.
 */
export function isFeatureEnabled(key: string): boolean {
  if (process.env.NODE_ENV !== 'production') {
    const override = localFlagOverride(key);
    if (override !== undefined) {
      return override;
    }
  }
  if (!initialized) {
    return false;
  }
  try {
    return posthog.isFeatureEnabled(key) === true;
  } catch (e) {
    return false;
  }
}

/** Whether PostHog has identified this browser by Last.fm username. */
export function isIdentified(): boolean {
  if (!initialized) {
    return false;
  }
  try {
    return posthog.get_property('$user_state') === 'identified';
  } catch (e) {
    return false;
  }
}
```

- [ ] **Step 2: report anonymous offers.** In `src/services/BackgroundScrobbling.ts`, import `isIdentified` alongside `isFeatureEnabled`, and change `backgroundOfferSource`:

```ts
export function backgroundOfferSource(): 'opt_in' | 'flag' | 'flag_anonymous' | null {
  if (!isBackgroundConfigured() || isBetaOptedOut()) {
    return null;
  }
  if (isBetaOptedIn()) {
    return 'opt_in';
  }
  if (!isFeatureEnabled(BACKGROUND_FLAG)) {
    return null;
  }
  return isIdentified() ? 'flag' : 'flag_anonymous';
}
```

Update its doc comment's last paragraph to mention `flag_anonymous` (the flag answered for a browser PostHog hasn't identified yet).

- [ ] **Step 3:** `npm run lint:check` (0 errors), `npx tsc --noEmit -p .`, `npx playwright test -c playwright.unreachable-worker.config.ts` (all pass). Commit "Honour the beta flag before sign-in".

---

### Task 2: Beta feedback banner on every page

**Files:** Modify `src/App.vue`; tests in `tests/unreachable-worker/unreachable-worker.spec.ts`.

Copy *(draft)*: `Background scrobbling is in beta. Something not working, or have a suggestion? Email niko@savas.ca.` followed by a `Switch it off` link.

- [ ] **Step 1: failing tests.** In the `BETA tag` describe of `tests/unreachable-worker/unreachable-worker.spec.ts`:
  - Rename "a browser outside the beta sees no tag; opting in shows the tag but no banner" to "a browser outside the beta sees no tag or banner; opting in shows both", and change its last assertion to expect `#beta-banner` visible and containing `niko@savas.ca` on `/?beta=1#/scrobble`, and `#beta-banner` count 0 on the first `/#/` load.
  - Add: `test('the beta banner shows on Home and About too, and Switch it off opts out', …)`: `goto('/?beta=1#/')` → `#beta-banner` visible; `goto('/#/about')` → visible; click `#beta-banner a:has-text("Switch it off")` → after the navigation, `#beta-banner` and `#logo .beta-tag` both have count 0, and `localStorage['scrobblify.background.beta']` is `'0'`.
  - Run `npx playwright test -c playwright.unreachable-worker.config.ts -g "BETA tag"` and see them fail.

- [ ] **Step 2: banner.** In `src/App.vue`, directly after the closing `</div>` of `#nav`, add:

```html
    <v-alert
      v-if="betaTag"
      id="beta-banner"
      type="info"
      variant="tonal"
      density="compact"
      class="mx-auto mb-4"
      max-width="720"
    >
      Background scrobbling is in beta. Something not working, or have a suggestion?
      Email <a href="mailto:niko@savas.ca">niko@savas.ca</a>.
      <a :href="betaOffHref">Switch it off</a>
    </v-alert>
```

Add a computed `betaOffHref` that rebuilds the current URL with `beta=0` in the query string, keeping the hash — the same logic `Scrobblify.vue` used before #150 (`git show 2c0a3b0:src/components/Scrobblify.vue`, `betaOffHref`), with its doc comment. The banner uses `betaTag` only (not `showingServerJob`): it is for beta users.

- [ ] **Step 3:** run the BETA tag tests (pass), the full worker-configured suite (pass), lint, tsc. Commit "Show a beta feedback banner on every page".

---

### Task 3: `SignInIntent` and a headless sign-in

**Files:** Create `src/services/SignInIntent.ts`; Modify `src/components/AuthenticateStep.vue`, `src/components/Scrobblify.vue`; tests in `tests/scrobblify.spec.ts`.

- [ ] **Step 1: create `src/services/SignInIntent.ts`:**

```ts
import LastFm from '@/api/LastFm';
import { trackEvent } from '@/services/Analytics';

/**
 * Why this browser went to Last.fm, so the page it comes back to can carry on.
 *
 * Kept in sessionStorage: Last.fm sends the user back in the same tab, and
 * nothing in memory survives that round trip.
 *
 *   send      a selection made while signed out, saved to IndexedDB as
 *             `importId`, is waiting to be sent
 *   resume    saved progress should resume once signed in
 *   reconnect the user asked to sign in from Home ("Re-connect to last.fm")
 */
export type SignInIntent =
  | { kind: 'send'; importId: string; checkDuplicates: boolean }
  | { kind: 'resume' }
  | { kind: 'reconnect' };

const KEY = 'scrobblify.signInIntent';

export function takeSignInIntent(): SignInIntent | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.kind === 'resume' || parsed.kind === 'reconnect')) {
      return { kind: parsed.kind };
    }
    if (parsed && parsed.kind === 'send' && typeof parsed.importId === 'string') {
      return { kind: 'send', importId: parsed.importId, checkDuplicates: parsed.checkDuplicates === true };
    }
    return null;
  } catch {
    return null;
  }
}

/** Records the intent and leaves for Last.fm. */
export function startSignIn(api: LastFm, intent: SignInIntent): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(intent));
  } catch {
    // Private modes can refuse storage. Sign-in still works; the page just
    // won't carry on by itself afterwards.
  }
  trackEvent('sign_in_started', { intent: intent.kind });
  window.location.href = api.getAuthorizeUrl();
}
```

- [ ] **Step 2: failing tests.** In `tests/scrobblify.spec.ts` add `routeLastFmSignIn` (see "Before you start") at module scope, then rewrite `test.describe('Scrobble Page - Authentication Step', …)`:
  - Replace "shows authentication step by default" and "shows Last.fm auth link" with `test('a signed-out visitor starts at upload, with no sign-in step', …)`: `interceptLastFm(page)`; `goto('/#/scrobble')`; `.upload-step` visible; `text=Authenticate with last.fm` count 0; `h1:has-text("Authorize")` count 0; `text=Currently authenticated as` count 0.
  - Keep "auto-advances when already authenticated" but rename to "a signed-in visitor starts at upload with their name shown": after `mockLastFmAuth` + reload, `.upload-step` visible and `text=Currently authenticated as: testuser` visible.
  - Keep the two token tests ("does not re-exchange a single-use token…", "shows a recovery prompt when the auth token is already used or expired"); they must keep passing against the headless handler (adjust only selectors that referenced the removed step-1 heading).
  - Run `$env:PORT=8644; npx playwright test tests/scrobblify.spec.ts -g "Authentication"` and see the first two fail.

- [ ] **Step 3: headless `AuthenticateStep`.** Replace its template with:

```html
<template>
  <div class="auth-handler">
    <div v-if="checkingAuth && hadToken" class="d-flex justify-center align-center mb-4">
      <v-progress-circular indeterminate color="primary" size="24" class="mr-2" aria-label="Signing in" />
      Signing in to Last.fm…
    </div>

    <v-alert v-if="tokenExpired" type="warning" prominent class="mb-4">
      <div>
        <strong>Your sign-in link was already used or has expired.</strong>
      </div>
      <div class="mt-1">
        Last.fm sign-in links can only be used once and expire after about an
        hour. This can also happen if the link was opened by a link preview or
        email-security scanner before you. Please authorize again to continue.
      </div>
      <div class="mt-2">
        <v-btn color="primary" :href="authorizeUrl">Authorize again</v-btn>
      </div>
    </v-alert>

    <error-dialog v-model="showError" :message="errorMessage" :details="errorDetails"></error-dialog>
  </div>
</template>
```

In the script add `hadToken: false` to `data()` and set `this.hadToken = !!this.$route.query.token;` at the start of `mounted()` (reuse it where the local `hadToken` const was). Remove the 2-second `setTimeout`: emit `complete` immediately when authenticated (`this.$emit('complete', { fresh: this.hadToken })`), and add `'complete'` payload docs to `emits`. Everything else in `mounted()` (token exchange, error handling, URL stripping, `identifyUser`, `auth_success`, clearing `HOME_DISMISSED_KEY`) stays. Remove the now-unused `finishStep` method. The "Signing in to Last.fm…" text is *(draft)*.

- [ ] **Step 4: `Scrobblify.vue` without step 1.**
  1. Move `<authenticate-step v-on:complete="onAuthenticated">` out of the stepper: render it directly above `<v-stepper>` (outside any `v-stepper-window-item`). Delete the `:value="1"` window item and the step-1 `v-stepper-item` and the `v-divider` after it.
  2. `currentStep` starts at `2` (data). `clearToken()` sets it to `2`.
  3. The "Currently authenticated as …" line shows when `isSignedIn` (new computed: `(this.$store.state.lfmApi as LastFm).isAuthenticated()`; also re-evaluate after sign-in: keep a `signedIn: false` data flag set in `onAuthenticated` and cleared in `clearToken`, and use `v-if="signedIn"`, because the store's `LastFm` isn't reactive).
  4. `onAuthenticated(payload?: { fresh?: boolean })`: set `this.signedIn = true`; drop the `if (this.currentStep === 1) this.currentStep = 2;` lines; keep the authority check. Then `await` the authority check (it is already called — restructure so the intent handling below runs after it settles: `await this.enforceServerAuthority().catch(() => this.onAuthorityUnanswered());`) and call `this.continueSignInIntent()` (Task 4 fills it in; for now an empty method).
  5. `restoreFromState` when not authenticated: delete `this.currentStep = 1;` (the sign-in banner carries it).
  6. The `signIn` banner's "Sign in to Last.fm" button becomes `@click="signInToResume"` (no `:href`); add method `signInToResume() { startSignIn(this.$store.state.lfmApi as LastFm, { kind: 'resume' }); }`.
  7. `stepName()` must still return names for 2–5 (step 1 unused). Check `step_viewed` on mount now reports step 2.
  8. Fix any other code or test that set or expected `currentStep === 1`.

- [ ] **Step 5:** `$env:PORT=8644; npx playwright test tests/scrobblify.spec.ts` — the full default spec (all pass; fix tests that clicked or waited on step-1 UI by using `mockLastFmAuth` as `goToUploadStep` does). Lint, tsc. Commit "Start /scrobble at upload; sign in only when needed".

---

### Task 4: Sign in when sending a fresh selection

**Files:** Modify `src/components/Scrobblify.vue`, `src/components/UploadStep.vue`, `src/scrobblify.ts`, `src/store.ts`; tests in `tests/scrobblify.spec.ts`.

- [ ] **Step 1: failing tests.** New `test.describe('Signing in after choosing', …)`:
  1. `a signed-out visitor chooses tracks, signs in, and lands ready to send`: `interceptLastFm`, `routeLastFmSignIn`, `goto('/#/scrobble')`; upload `FIXTURE_ZIP`, Find tracks, Choose, select all, `scrobbleSelection(page)` (which clicks "Start scrobbling"); expect the URL to come back to `#/scrobble` (token stripped), `text=Currently authenticated as: testuser` visible, the Scrobble step's `button:has-text("Scrobble")` (exact) visible, and `readSavedState(page)` to have `totalTracks` equal to the selected count and `completedIndices` empty. Then click Scrobble and expect `text=Finished scrobbling >> visible=true` (as other tests do), and the scrobble requests count to equal the selection.
  2. `the duplicate check waits for sign-in and then skips plays already on Last.fm`: same, but tick "Check for duplicates" before Find tracks, and seed the mock library so 2 of the fixture's plays already exist (see how existing duplicate tests seed `MockLibrary`; reuse that helper). Expect the upload log to say the check will run after sign-in, and after return `text=Skipped 2 that are already on Last.fm.` visible and the queue 2 shorter.
  3. `a signed-in visitor still checks duplicates during upload` — existing behaviour; if an existing test already covers it, leave it.
  Run and see 1–2 fail.

- [ ] **Step 2: store flag.** `src/store.ts`: state `deferredDuplicateCheck: false` + mutation `setDeferredDuplicateCheck(state, on: boolean)`, with a one-line comment (true when the user ticked "Check for duplicates" while signed out, so the check runs after sign-in).

- [ ] **Step 3: `UploadStep` defers when signed out.** In the duplicate branch, before `filterDuplicates`: if `!(this.$store.state.lfmApi as LastFm).isAuthenticated()`, push log line `Duplicates will be checked after you sign in.` *(draft)*, set `toBeScrobbled = validData`, commit `setDeferredDuplicateCheck(true)`, and skip the fetch. Otherwise commit `setDeferredDuplicateCheck(false)` and behave as today. `upload_parse_completed` gains `duplicates_deferred: boolean`.

- [ ] **Step 4: queue duplicate filter.** In `src/scrobblify.ts` add `filterQueuedDuplicates(scrobbles: Scrobble[], onProgress?)` returning `{ unique: Scrobble[]; duplicateCount: number }`: map each `Scrobble` to the shape `filterDuplicates` needs (`trackName`, `artistName`, `listenDate`, `reTagged`), run the same algorithm, and map back, keeping order. Refactor so both methods share one implementation (e.g. a private generic over an accessor) rather than duplicating the matching loop.

- [ ] **Step 5: save and leave when signed out.** In `Scrobblify.vue` `onSelectionComplete()`: if not signed in,

```ts
      const api = this.$store.state.lfmApi as LastFm;
      if (!api.isAuthenticated()) {
        const state = this.buildState({
          scrobbledTracks: 0,
          originalTotalTracks: (this.$store.state.selectedScrobbles as Scrobble[]).length,
          originalSucceededCount: 0,
          pendingVerification: [],
          sendTimestamps: [],
          lastReTagTimestampSec: this.$store.state.reTagCursorSec as number,
          burstCount: 0,
          dailyCount: 0,
        } as ProgressSnapshot);
        await this.persist(() => this.stateManager.saveState(state));
        startSignIn(api, {
          kind: 'send',
          importId: state.importId || '',
          checkDuplicates: this.$store.state.deferredDuplicateCheck as boolean,
        });
        return;
      }
```

Check `ProgressSnapshot`'s real fields and `persist()`'s signature in `Scrobblify.vue` and build the snapshot accordingly (every required field present). If the save throws, show the existing error dialog ("Couldn't save your selection before signing in.") and stay on Choose. Make `onSelectionComplete` async.

- [ ] **Step 6: carry on after sign-in.** Fill in `continueSignInIntent()`:

```ts
    async continueSignInIntent() {
      const intent = takeSignInIntent();
      if (!intent || intent.kind === 'reconnect') {
        return;
      }
      if (intent.kind === 'resume') {
        if (this.hasResumableState) {
          await this.resumeFromSaved();
        }
        return;
      }
      const state = await this.stateManager.loadState().catch(() => null);
      if (!state || (state.importId || '') !== intent.importId || state.completedIndices.length > 0) {
        return;
      }
      const ready = intent.checkDuplicates ? await this.dropQueuedDuplicates(state) : state;
      this.restoreFromState(ready, 'sign_in');
    },
```

`dropQueuedDuplicates(state)`: set `checkingDuplicates = true` (renders `Checking for plays already on Last.fm…` *(draft)* with a spinner above the stepper), deserialize `state.tracks`, run `filterQueuedDuplicates`, and if any were dropped rebuild the state (`tracks`, `totalTracks`, `originalTotalTracks`), save it with `persist`, and set `skippedDuplicates = duplicateCount` (renders `Skipped {skipped} that are already on Last.fm.` *(draft)* as an info alert above the stepper until the user starts sending). On failure, `trackError('scrobblify.deferredDuplicates', e)` and continue with the unfiltered state. Always clear `checkingDuplicates`.

In `restoreFromState`, for `source === 'sign_in'`: emit `selection_resumed_after_sign_in` (`track_count`, `duplicates_skipped`) **instead of** `session_resumed`, so the resume funnel isn't polluted. Everything else is the same (it lands on step 4 and may show the background offer).

While a `send` intent is waiting (read it with a non-consuming peek in `mounted` before `exposeSavedStateUnlessStale` runs), don't offer the "Resume previous session?" banner for that same `importId`: it is the selection about to be restored, not old progress. Add `peekSignInIntent()` to `SignInIntent.ts` for this (same parsing as `takeSignInIntent`, without removing the key).

The `resume` branch must respect the authority check: `continueSignInIntent` runs after `enforceServerAuthority` settles, and `resumeFromSaved` already refuses while blocked.

- [ ] **Step 7:** run the new describe, the full default spec, the full worker-configured suite, lint, tsc. Commit "Sign in when sending a selection made while signed out".

---

### Task 5: Home's Continue and Re-connect start the sign-in

**Files:** Modify `src/views/Home.vue`; tests in `tests/scrobblify.spec.ts`.

- [ ] **Step 1: failing tests** in "Home Page":
  - `Continue on saved progress while signed out signs in and resumes`: seed saved state (`SAVED`) and only the username; `interceptLastFm`, `routeLastFmSignIn`; click Continue; expect to land on `#/scrobble` signed in, past the resume banner, on the Scrobble step (`button:has-text("Scrobble")` exact visible) with no `text=Resume previous session` banner.
  - `Re-connect to last.fm signs in and opens the scrobble page`: first visit; click Re-connect; expect `#/scrobble`, `text=Currently authenticated as: testuser`, and the `home_choice` `resume` event.
  - Update the existing "Re-connect" and saved-card Continue tests that only expected `#/scrobble`.

- [ ] **Step 2: Home.** `go('resume')` (Re-connect): track `home_choice`, then `startSignIn(api, { kind: 'reconnect' })` — unless already signed in, in which case push `/scrobble` as today. `openScrobble` for `continue` on a `saved` card with `signedIn: false`: `startSignIn(api, { kind: 'resume' })`; otherwise push `/scrobble`. Start over and Upload still push `/scrobble`.

- [ ] **Step 3:** run "Home Page" (pass), full default spec, lint, tsc. Commit "Continue and Re-connect on Home sign in first".

---

### Task 6: Server authority after the new sign-in

**Files:** tests in `tests/unreachable-worker/unreachable-worker.spec.ts`.

Spec 4.5: a user with a live server job who uploads again on a fresh browser and signs in must get the job, not send.

- [ ] **Step 1: test.** `a fresh browser that chooses and signs in while a job is live sends nothing`: route the worker so `/scrobblify/job/live` answers `{ ok: true, live: true }` for `testuser` (and capacity/import as `WILLING_WORKER`); `routeLastFmSignIn` (define it in this spec too, or move it to `tests/lastfmMock.js` and export it — prefer the latter, then import it in both specs); signed out, upload, choose, start; after the return, expect no `track.scrobble` requests within 3 s, and the "live" notice or job banner visible. Run it.
- [ ] **Step 2:** if it fails, fix `continueSignInIntent`/`onAuthenticated` ordering so nothing restores or sends until `enforceServerAuthority` has answered, and so a live job leaves the saved selection untouched. Commit "Keep the server-authority check in front of the moved sign-in".

---

### Task 7: Docs

**Files:** `AGENTS.md`, `docs/superpowers/specs/2026-11-20-guided-home-and-background-design.md`, `docs/superpowers/specs/2026-11-20-guided-home-strings.md`.

- [ ] `AGENTS.md`:
  - **Funnel events:** the order is now `step_viewed` (step 2 first) → `upload_parse_*` → `tracks_selected` → `sign_in_started` (`intent`: `send` / `resume` / `reconnect`) → `auth_success` → `selection_resumed_after_sign_in` (`track_count`, `duplicates_skipped`) → `scrobble_started` …; a signed-in user skips the sign-in events. `upload_parse_completed` gains `duplicates_deferred`. Note the date of the change and that `step_viewed` no longer reports step 1.
  - **"A cleared key must never be resumed past"**: update the description of `restoreFromState` (no step 1; the sign-in banner's button starts a `resume` sign-in that resumes by itself afterwards).
  - **Beta gate:** `isFeatureEnabled` no longer requires identification; `offer_source` adds `flag_anonymous`; the beta banner is back on every page (`#beta-banner`, `betaOffHref` in `App.vue`), with the feedback line.
  - **Sign-in intents:** a short paragraph on `src/services/SignInIntent.ts` (sessionStorage `scrobblify.signInIntent`, the three kinds, read once in `onAuthenticated` after the authority check), and that a signed-out selection is saved as an ordinary 0-progress `ScrobbleState` before the redirect, so an abandoned sign-in shows up as saved progress next time.
- [ ] Spec: in section 4.1/4.4, note that worker-only sign-in moved to Plan 3 (worker preflight and signin need a username today); in 4.3 note the duplicate check runs during upload when already signed in.
- [ ] Strings file: add the *(draft)* strings from this plan under a new "Added in Plan 2" section: `signin.signingIn` ("Signing in to Last.fm…"), `upload.dupesDeferred` ("Duplicates will be checked after you sign in."), `signin.checking.body`, `signin.dupes.body` (already present: reuse their IDs), `beta.banner` ("Background scrobbling is in beta. Something not working, or have a suggestion? Email niko@savas.ca.") and `beta.banner.off` ("Switch it off").
- [ ] Commit "Document sign-in after choosing".

---

### Task 8: Full verification and real browser testing

- [ ] `npm run lint:check`, `npx tsc --noEmit -p .`, `npm run build` (and `dist/.htaccess` exists).
- [ ] Full default suite on 8644, full worker-configured suite.
- [ ] Real browser (Orca browser, `npm run dev:mock:bg` on a free port, fresh storage), check each and screenshot:
  1. Signed out: `/scrobble` opens on Upload, no step 1; beta banner on Home, About and `/scrobble` with `?beta=1`; Switch it off works.
  2. Signed out: upload with "Check for duplicates", choose, Start scrobbling → mock Last.fm → back on Send, signed in, skipped-duplicates line, Scrobble sends.
  3. Pause, go Home: card shows the progress; sign out in another way (clear `scrobblifyLfmAuthKey` in devtools), reload Home, Continue → sign-in → lands resumed on Send.
  4. Re-connect from a first visit → signed in on `/scrobble`.
  5. With `?beta=1`: after sign-in, a large import still gets the background offer; hand over; Home shows the job.
- [ ] File an issue for any bug found that isn't fixed here.
