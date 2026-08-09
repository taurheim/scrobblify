<template>
  <div class="scrobblify">
    <div v-if="currentStep > 1">
      Currently authenticated as: {{ this.$store.state.lfmApi.userName }}.
      <a role="button" tabindex="0" @click="clearToken" @keydown.enter="clearToken">Not you?</a>
    </div>

    <!--
      A live server-side job outranks everything else on this page. If it is
      running and the user also has local progress, offering "Resume" would
      invite them to scrobble the same tracks the server is scrobbling, so the
      job banner replaces the resume prompt rather than sitting beside it.
    -->
    <v-alert v-if="backgroundJob" :type="jobAlertType" prominent class="mb-4">
      <div>
        <strong>{{ jobHeadline }}</strong>
        <v-chip x-small color="deep-purple" text-color="white" class="ml-2">Beta</v-chip>
      </div>
      <div class="mt-1">
        {{ backgroundJob.scrobbled.toLocaleString() }} of
        {{ backgroundJob.totalTracks.toLocaleString() }} scrobbled<span
          v-if="backgroundJob.failed > 0"
        >, {{ backgroundJob.failed.toLocaleString() }} rejected by Last.fm</span>.
        <span v-if="jobEta">{{ jobEta }}</span>
      </div>
      <div v-if="backgroundJob.reason" class="mt-1 text-body-2">{{ backgroundJob.reason }}</div>
      <div class="mt-2">
        <v-btn
          v-if="backgroundJob.state === 'active'"
          outlined
          class="mr-2"
          :loading="backgroundBusy"
          @click="pauseBackgroundJob"
        >Pause</v-btn>
        <v-btn
          v-else-if="backgroundJob.state === 'paused'"
          color="primary"
          class="mr-2"
          :loading="backgroundBusy"
          @click="resumeBackgroundJob"
        >Resume on the server</v-btn>
        <v-btn outlined class="mr-2" :loading="backgroundBusy" @click="takeBackProgress">
          Take my progress back
        </v-btn>
        <v-btn text @click="refreshBackgroundJob">Refresh</v-btn>
      </div>
    </v-alert>

    <v-alert v-if="backgroundNotice" type="warning" class="mb-4">
      {{ backgroundNotice }}
      <div v-if="showReauth" class="mt-3">
        <v-btn color="primary" :loading="reauthBusy" @click="reauthenticate">
          Sign in to the background service
        </v-btn>
      </div>
    </v-alert>

    <v-alert v-if="authorityUnknown" type="warning" class="mb-4">
      <div>
        <strong>Can't reach the background service.</strong>
        Scrobbling is held back until it can confirm that an import isn't
        already running on the server for your account — sending the same
        tracks twice can't be undone.
      </div>
      <div class="mt-3">
        <v-btn color="primary" :loading="authorityPending" @click="retryAuthority">
          Try again
        </v-btn>
      </div>
    </v-alert>

    <v-alert
      v-if="hasResumableState && currentStep <= 2 && !backgroundJob && !ownershipBlocked
        && !authorityPending && !authorityUnknown"
      type="info"
      prominent
      class="mb-4"
    >
      <div>
        <strong>Resume previous session?</strong>
        You have saved progress from a previous scrobbling session.
      </div>
      <div class="mt-2">
        <v-btn color="primary" class="mr-2" @click="resumeFromSaved">Resume</v-btn>
        <v-btn outlined @click="importStateFile">Import from file</v-btn>
        <v-btn text color="error" @click="clearSavedState">Discard</v-btn>
      </div>
      <input
        ref="importFileInput"
        type="file"
        accept=".json"
        aria-label="Import saved session file"
        style="display: none"
        @change="onImportFile"
      >
    </v-alert>
    <v-stepper v-model="currentStep">
      <v-stepper-header>
        <v-stepper-step :complete="currentStep > 1" step="1">Authenticate with last.fm</v-stepper-step>
        <v-divider></v-divider>
        <v-stepper-step :complete="currentStep > 2" step="2">Upload your spotify play history</v-stepper-step>
        <v-divider></v-divider>
        <v-stepper-step :complete="currentStep > 3" step="3">Choose which tracks to scrobble</v-stepper-step>
        <v-divider></v-divider>
        <v-stepper-step :complete="currentStep > 4" step="4">Scrobble!</v-stepper-step>
        <v-divider></v-divider>
        <v-stepper-step step="5">Complete</v-stepper-step>
      </v-stepper-header>
      <v-stepper-items>
        <v-stepper-content step="1">
          <authenticate-step v-on:complete="onAuthenticated"></authenticate-step>
        </v-stepper-content>
        <v-stepper-content step="2">
          <upload-step v-on:complete="currentStep = 3"></upload-step>
        </v-stepper-content>
        <v-stepper-content step="3">
          <select-step v-on:complete="currentStep = 4"></select-step>
        </v-stepper-content>
        <v-stepper-content step="4">
          <scrobble-step
            ref="scrobbleStep"
            :background-available="backgroundAvailable"
            :sending-blocked="sendingBlocked"
            :persist-progress="onAutoSave"
            :persist-progress-if-ahead="onAutoSaveIfAhead"
            v-on:complete="onScrobbleComplete"
            v-on:save-and-exit="onSaveAndExit"
            v-on:auto-save="onAutoSaveBestEffort"
            v-on:background="onBackgroundRequested"
          ></scrobble-step>
        </v-stepper-content>
        <v-stepper-content step="5">
          <complete-step :has-remaining="hasRemainingTracks"></complete-step>
        </v-stepper-content>
      </v-stepper-items>
    </v-stepper>
    <background-offer
      v-model="showBackgroundOffer"
      :remaining="backgroundRemaining"
      :all-re-tagged="backgroundAllReTagged"
      :busy="backgroundBusy"
      v-on:accept="startBackgroundHandoff"
      v-on:decline="onBackgroundDeclined"
    ></background-offer>
    <error-dialog v-model="showError" :message="errorMessage" :details="errorDetails"></error-dialog>
  </div>
</template>
<style>
</style>
<script lang="ts">
import Vue from 'vue';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble from '@/models/Scrobble';
import Scrobblify from '@/scrobblify';

// Steps
import AuthenticateStepVue from '@/components/AuthenticateStep.vue';
import SelectStepVue from '@/components/SelectStep.vue';
import UploadStepVue from '@/components/UploadStep.vue';
import LastFm from '@/api/LastFm';
import ScrobbleStepVue from '@/components/ScrobbleStep.vue';
import CompleteStepVue from '@/components/CompleteStep.vue';
import StateManager, { ScrobbleState } from '@/services/StateManager';
import RateLimitTracker from '@/services/RateLimitTracker';
import ErrorDialog from '@/components/ErrorDialog.vue';
import BackgroundOffer from '@/components/BackgroundOffer.vue';
import * as background from '@/services/BackgroundScrobbling';
import {
  beginHandoff, completeHandoff, uploadListFromState, stateFromExport,
} from '@/services/BackgroundHandoff';
import { trackEvent, trackError, resetUser } from '@/services/Analytics';

/**
 * How far back the browser's re-tag allocator reaches.
 *
 * Must match `RETAG_BACKFILL_SECONDS` in `ScrobbleStep`, which is what
 * actually allocates. Used here only to bound a band whose exact extent was
 * not recorded, so an over-estimate is the safe direction.
 */
const RETAG_BACKFILL_SECONDS = 6 * 60 * 60;

interface ProgressSnapshot {
  scrobbledTracks: number;
  originalTotalTracks: number;
  originalSucceededCount: number;
  sendTimestamps: number[];
  lastReTagTimestampSec: number;
  /**
   * Synthetic second already sent for the track at the head of the queue,
   * while its outcome is unknown. Absent when nothing is in flight.
   */
  pendingReTagTimestampSec?: number;
  burstCount: number;
  dailyCount: number;
}

export default Vue.extend({
  components: {
    'authenticate-step': AuthenticateStepVue,
    'upload-step': UploadStepVue,
    'select-step': SelectStepVue,
    'scrobble-step': ScrobbleStepVue,
    'complete-step': CompleteStepVue,
    'error-dialog': ErrorDialog,
    'background-offer': BackgroundOffer,
  },
  data() {
    return {
      currentStep: 1,
      hasResumableState: false,
      hasRemainingTracks: false,
      stateManager: new StateManager(),
      showError: false,
      errorMessage: '',
      errorDetails: '',
      showBackgroundOffer: false,
      backgroundAvailable: false,
      backgroundRemaining: 0,
      backgroundAllReTagged: false,
      backgroundBusy: false,
      backgroundJob: null as background.JobStatus | null,
      backgroundNotice: '',
      /** Snapshot from the scrobble step, held while the offer dialog is open. */
      pendingSnapshot: null as ProgressSnapshot | null,
      /** State to hand off, when the offer came from a resume rather than a live queue. */
      pendingState: null as ScrobbleState | null,
      /** Retained so the listener can be removed again. Not reactive state. */
      onPageShow: null as ((event: PageTransitionEvent) => void) | null,
      /** Teardown for the cross-tab ownership subscription. Not reactive. */
      releaseOwnershipListener: null as (() => void) | null,
      /** Teardown for the cross-tab freeze responder. Not reactive. */
      releaseFreezeResponder: null as (() => void) | null,
      releaseTabRoster: null as (() => void) | null,
      /**
       * Set when we cannot establish whether the server owns the queue. A
       * belt-and-braces gate on Resume alongside `hasResumableState`: that flag
       * is recomputed in several places, and any one of them forgetting the
       * ownership question would re-expose the duplicate path.
       */
      ownershipBlocked: false,
      /**
       * True until the server has answered whether anything is running for
       * this user, and again whenever that answer could not be obtained.
       *
       * Separate from `ownershipBlocked`, which means "the answer was yes".
       * This one means "there is no answer", and it has to gate the same
       * actions: the whole point of asking is defeated if Resume is live while
       * the request is still in flight. `mounted` is async and Vue renders at
       * every await, so that window is real rather than theoretical.
       */
      authorityPending: true,
      /**
       * Set when the authority question could not be answered at all. Distinct
       * from a `false` answer, and surfaced so the user is told why the app is
       * holding back rather than silently refusing to work.
       */
      authorityUnknown: false,
      /** Pending automatic retry of the ownership check, and its backoff. */
      authorityRetryTimer: null as number | null,
      authorityRetryCount: 0,
      /**
       * Shown only when the block is caused by an expired bearer token, which
       * is the one unresolved case the user can actually fix themselves.
       */
      showReauth: false,
      reauthBusy: false,
    };
  },
  async mounted() {
    trackEvent('step_viewed', { step: this.currentStep, step_name: this.stepName(this.currentStep) });

    // Ordering matters. A handoff coming back from Last.fm must be finished
    // before anything reads local state, because the upload derives its bytes
    // from that state and completing the handoff is what clears it.
    //
    // A re-authentication return is consumed first, and only for its token: it
    // owns no handoff and must not be mistaken for one.
    const reauthed = background.consumeReauthFragment();

    const resumed = await this.resumeHandoffIfReturning();
    if (resumed) {
      return;
    }

    await this.refreshBackgroundJob();

    /*
      Ownership is settled before resumability is ever assigned. `mounted` is
      async, so every `await` below is a point at which Vue can render; setting
      `hasResumableState = true` first and checking ownership afterwards would
      put a Resume button on screen for the whole duration of a status request,
      which is exactly the window in which the server may own the queue.
    */
    const unresolved = background.getOwnershipUnresolved();
    const owner = background.queueOwner();

    try {
      const saved = await this.stateManager.hasSavedState();
      this.hasResumableState = saved && !unresolved && !owner;
    } catch (e) {
      // IndexedDB not available — not critical, just skip resume
    }

    /*
      A tab opened after another tab took the queue has no message to receive,
      so the durable record is read here as well as listened for.

      A `server` record is reconciled rather than obeyed forever. Jobs run for
      weeks and then finish; without this the flag that stopped every tab
      during the import would keep stopping them long after the worker was
      done, and there would be no way back.
    */
    if (owner) {
      this.ownershipBlocked = true;
      await this.reconcileQueueOwner(owner);
    }

    /*
      The authority check, after the local records have had their say so it can
      correct them in either direction.

      Deliberately not conditional on finding a local record: a browser with no
      record is the case this exists for. It is also deliberately awaited
      before the resume button can appear — `hasResumableState` above may
      already be true, and offering Resume while the question is open is
      offering the one action that starts duplicate scrobbling. `authorityPending`
      covers the same window in the template, since `mounted` renders at every
      await it makes.
    */
    await this.enforceServerAuthority().catch(() => {
      this.authorityPending = false;
      this.authorityUnknown = true;
      this.scheduleAuthorityRetry();
    });

    this.releaseOwnershipListener = background.onServerOwnershipChange((next) => {
      this.ownershipBlocked = next !== null;
      const step = this.$refs.scrobbleStep as any;
      if (next) {
        this.hasResumableState = false;
        if (step && step.haltForHandoff) {
          // Deliberately not awaited: this is an event handler, and the halt
          // resolves only once the in-flight batch finishes.
          Promise.resolve(step.haltForHandoff()).catch(() => { /* best effort */ });
        }
      } else if (step && step.releaseHandoffHalt) {
        /*
          Ownership was released, so whatever stopped this tab did not happen.
          Without this the halt outlives it: a failed preflight in another tab
          leaves every sibling `handoffHalted`, and "Resume" cannot restart
          them because the flag is checked at the top of the send loop.
        */
        step.releaseHandoffHalt();
        this.hasResumableState = true;
      }
    });

    // Registered so other tabs can tell how many siblings a freeze must wait
    // for. Without a roster, "everyone has stopped" is not observable and a
    // freezing tab can only guess at a timeout.
    this.releaseTabRoster = background.joinTabRoster();

    /*
      This tab answers other tabs' freeze requests. Handing over is decided in
      one tab and binds them all, and the decision is made *before* the queue
      is snapshotted — so this must stop scrobbling and persist what it has
      before acknowledging, or its just-sent tracks are captured in the
      sibling's upload and scrobbled a second time by the worker.
    */
    this.releaseFreezeResponder = background.respondToFreezeRequests(async () => {
      const step = this.$refs.scrobbleStep as any;
      if (step && step.haltForHandoff) {
        /*
          The boolean is load-bearing. `haltForHandoff` returns false when the
          loop was still running after its polling budget — which is exactly
          the in-flight Last.fm request case — and answering "stopped" then
          would let the sibling upload a queue this tab is still sending from.
        */
        if (!await step.haltForHandoff()) {
          return false;
        }
        /*
          Persisted here, synchronously with the acknowledgement, rather than
          via the usual `auto-save` event: that only emits, and the freezing
          tab re-reads IndexedDB the moment this resolves. An unawaited save
          would not have landed.

          `saveStateIfAhead` rather than `saveState` because several tabs
          persist at once during a freeze and a plain put is last-writer-wins;
          the slowest snapshot would otherwise erase the furthest progress.
        */
        try {
          const snapshot = step.progressSnapshot();
          if (snapshot) {
            await this.stateManager.saveStateIfAhead(this.buildState(snapshot));
          }
        } catch (e) {
          trackError('background.freezePersist', e);
          return false;
        }
      }
      this.hasResumableState = false;
      this.ownershipBlocked = true;
      return true;
    });

    if (unresolved) {
      await this.resolveOwnership(unresolved);
    }
    if (reauthed) {
      trackEvent('background_reauth_completed', { resolved: String(!this.ownershipBlocked) });
    } else if (new URLSearchParams(window.location.search).get('signin') === 'failed') {
      this.backgroundNotice = 'Signing in to the background service didn\'t work. Please try again.';
      this.showReauth = true;
      this.stripQuery();
      trackEvent('background_reauth_failed');
    }
    this.probeBackgroundAvailability();

    /*
      Back-forward cache recovery.

      Handing over navigates this tab to Last.fm with `backgroundBusy` left set
      and the scrobble loop halted, deliberately: it stops the dialog being
      submitted twice while the redirect is in flight. If the user then presses
      Back instead of authorising, the browser may restore this exact page from
      the bfcache — same JavaScript state, no `mounted()`, no reload — leaving a
      permanently busy screen with a stopped loop and no way out but a refresh.

      `pageshow` with `persisted` is the only event that fires in that case.
    */
    this.onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        this.recoverFromBfcache();
      }
    };
    window.addEventListener('pageshow', this.onPageShow);
  },
  beforeDestroy() {
    if (this.onPageShow) {
      window.removeEventListener('pageshow', this.onPageShow);
    }
    if (this.releaseOwnershipListener) {
      this.releaseOwnershipListener();
    }
    if (this.releaseFreezeResponder) {
      this.releaseFreezeResponder();
    }
    if (this.releaseTabRoster) {
      // Leaves the roster, so a closed tab does not make every future handoff
      // wait out the full window for an acknowledgement that cannot come.
      this.releaseTabRoster();
    }
    if (this.authorityRetryTimer) {
      window.clearTimeout(this.authorityRetryTimer);
      this.authorityRetryTimer = null;
    }
  },
  watch: {
    currentStep(step: number) {
      trackEvent('step_viewed', { step, step_name: this.stepName(step) });
    },
  },
  computed: {
    /*
      Whether this browser is allowed to send at all.

      The Resume alert was gated on the same conditions, but a hidden button is
      not a guard: Upload and Select advance to the scrobble step through their
      own completion handlers, so a user who imports a fresh file reaches the
      send loop without ever passing the alert. That is the same browser and
      the same account, and if a worker holds this user's queue those sends
      land underneath it.

      `ownershipBlocked` is a known remote owner; the other two are "we do not
      know yet" and "we could not find out". All three withhold sending,
      because the only safe default when ownership is unresolved is silence.
    */
    sendingBlocked(): boolean {
      return this.ownershipBlocked || this.authorityPending || this.authorityUnknown;
    },
    jobAlertType(): string {
      if (!this.backgroundJob) { return 'info'; }
      if (this.backgroundJob.state === 'completed') { return 'success'; }
      if (this.backgroundJob.state === 'active') { return 'info'; }
      return 'warning';
    },
    jobHeadline(): string {
      if (!this.backgroundJob) { return ''; }
      switch (this.backgroundJob.state) {
        case 'active':
          return 'Scrobblify is finishing your import in the background.';
        case 'paused':
          return 'Your background import is paused.';
        case 'completed':
          return 'Your background import has finished.';
        case 'needs_reauth':
          return 'Your background import needs you to reconnect Last.fm.';
        case 'needs_attention':
          return 'Your background import has stopped and needs a look.';
        default:
          return 'Your background import has stopped.';
      }
    },
    jobEta(): string {
      const job = this.backgroundJob;
      if (!job || job.state !== 'active' || !job.estimatedCompletionSec) { return ''; }
      const days = Math.ceil(job.estimatedCompletionSec / 86400);
      if (days <= 1) { return 'Should finish within a day.'; }
      return `Should finish in about ${days} days.`;
    },
  },
  methods: {
    stepName(step: number): string {
      return ['', 'authenticate', 'upload', 'select', 'scrobble', 'complete'][step] || String(step);
    },

    // ---- background scrobbling ----

    /**
     * Whether the offer may be shown at all.
     *
     * Deliberately conservative. Every "no" here just leaves the user with the
     * behaviour they already had, whereas offering a handoff the browser or
     * server cannot actually complete strands them mid-redirect.
     */
    canOfferBackground(remaining: number): boolean {
      return this.backgroundAvailable
        && !this.backgroundJob
        && remaining >= 2700;
    },

    /**
     * Asks the server, by username, whether anything is running for this user,
     * and blocks the browser if so.
     *
     * This is the authority. Every other ownership signal in this component is
     * a local record, and local records answer only for the browser that wrote
     * them — not for a browser whose storage was cleared, not for a second
     * device, not for another profile. All three of those can still open a
     * saved import from IndexedDB and start sending it underneath a running
     * job, and the duplicate scrobbles that follow are silent: Last.fm accepts
     * a repeat of the same track and second and simply discards it.
     *
     * Keyed on the Last.fm username rather than a session token precisely
     * because losing the session is one of the cases being caught. It runs
     * unauthenticated for that reason, and returns a bare boolean, so a `true`
     * can block but cannot render details — signing in is what unlocks those.
     *
     * Tri-state, and the three answers are not symmetrical:
     *   `true`  — block, durably, and offer the sign-in that leads to control.
     *   `false` — definitive. Safe to release a stale `server` record that a
     *             finished job left behind.
     *   `null`  — unreachable or unparseable. Change nothing. The local
     *             records keep whatever they were already saying, so this is
     *             never worse than not having asked.
     */
    async enforceServerAuthority(): Promise<void> {
      if (!background.isBackgroundConfigured()) {
        // The feature does not exist for this build, so no queue of ours can
        // be running anywhere. Nothing to withhold.
        this.authorityPending = false;
        this.authorityUnknown = false;
        return;
      }
      /*
        The signed-in user if there is one, and otherwise the name carried by
        the saved import itself.

        The fallback matters: a browser that has lost its localStorage has also
        lost its Last.fm login, but IndexedDB is a separate store and the queue
        can easily outlive both. That browser is precisely the one this check
        exists for, and without the fallback it is the one browser that never
        gets asked about.
      */
      let username = (this.$store.state.lfmApi as LastFm).getUserName() || '';
      if (!username) {
        try {
          const saved = await this.stateManager.loadState();
          username = (saved && saved.userName) || '';
        } catch (e) {
          // Unreadable state. There is nothing to resume either, so the
          // question is moot.
        }
      }
      if (!username) {
        this.authorityPending = false;
        this.authorityUnknown = false;
        return;
      }

      // Captured before the round-trip: the release below must prove that the
      // record it clears is the one this answer was about, since another tab
      // can establish a freeze while the request is in flight.
      const observed = background.queueOwner();
      const live = await background.liveJobForUsername(username);
      this.authorityPending = false;

      if (live === true) {
        /*
          Written durably rather than held in memory. This tab may be the only
          one that asked, and the record is what tells a tab opened tomorrow —
          which will not repeat this check until its own next load — that the
          queue is not its to send.

          No id: this endpoint deliberately returns no job id, and a `server`
          record whose id names something other than a job would be read as an
          answer about that thing. The empty id is the legacy "any live job
          counts" form, which is the conservative reading.
        */
        if (!observed || observed.owner === 'server') {
          background.setQueueOwner({ owner: 'server', id: '' });
        }
        this.authorityUnknown = false;
        this.ownershipBlocked = true;
        this.hasResumableState = false;
        // With a valid session this renders the real status card, with pause,
        // resume and take-back. Without one there is nothing to show but the
        // block itself, so offer the sign-in that turns it into a status card.
        await this.refreshBackgroundJob();
        if (!this.backgroundJob) {
          this.showReauth = true;
          this.backgroundNotice = 'Your import is still running on the server, so scrobbling from this browser is switched off to stop the same tracks being sent twice. Sign in to check on it or bring it back here.';
        }
        trackEvent('background_authority_check', { result: 'live', signed_in: String(!!this.backgroundJob) });
        return;
      }

      if (live === false) {
        this.authorityUnknown = false;
        /*
          Only a `server` record may be released on this answer. A `freezing`
          record means a sibling tab is part-way through a handover *right
          now* — the job legitimately does not exist yet, and reading that as
          "nothing is running" would unblock every tab inside the exact window
          the freeze exists to protect.
        */
        if (observed && observed.owner === 'server') {
          background.releaseQueueOwnerIfSame(observed);
          this.ownershipBlocked = false;
        }
        try {
          this.hasResumableState = await this.stateManager.hasSavedState();
        } catch (e) {
          // Nothing to restore the button for.
        }
        trackEvent('background_authority_check', { result: 'idle' });
        return;
      }

      /*
        No answer. Deliberately *not* treated as "nothing is running".

        This is the case the whole mechanism exists for: a browser with no
        local record is indistinguishable, from the inside, between "never
        handed anything over" and "handed over from a device whose record I
        have never seen". Only the server can tell those apart, so until it
        does, the action that would start duplicate scrobbling stays withheld.

        The user is told why, and given a retry, rather than left looking at an
        app that silently refuses to work.
      */
      this.authorityUnknown = true;
      this.hasResumableState = false;
      // Self-clearing: a blip must not leave the app permanently unable to
      // scrobble just because nobody pressed the retry button.
      this.scheduleAuthorityRetry();
      trackEvent('background_authority_check', { result: 'unknown' });
    },

    /**
     * Retries the authority question after it could not be answered.
     */
    async retryAuthority(): Promise<void> {
      this.authorityPending = true;
      this.authorityUnknown = false;
      await this.enforceServerAuthority();
    },

    /**
     * Keeps retrying the ownership check until it gets an answer.
     *
     * Refusing to send while ownership is unknown is the right default, but on
     * its own it converts a momentary network blip into a page that will not
     * scrobble until the user notices a button and presses it. Scrobbling
     * locally is this app's entire purpose, so the refusal has to be
     * self-clearing.
     *
     * Backs off to a minute and then stays there — a genuine outage should not
     * be hammered, but it should be noticed promptly whenever it ends.
     */
    scheduleAuthorityRetry(): void {
      if (this.authorityRetryTimer) {
        return;
      }
      const delay = Math.min(60000, 2000 * (2 ** Math.min(this.authorityRetryCount, 5)));
      this.authorityRetryCount += 1;
      this.authorityRetryTimer = window.setTimeout(async () => {
        this.authorityRetryTimer = null;
        if (!this.authorityUnknown) {
          return;
        }
        await this.retryAuthority();
      }, delay);
    },

    /**
     * Decides whether an ownership record still reflects reality.
     *
     * A boolean flag set at handover was a one-way door: jobs complete, fail
     * or are cancelled, and nothing was left to clear it. A user whose import
     * finished would find every tab permanently refusing to scrobble, with no
     * marker to resolve and nothing to press.
     *
     * Only a definitive "that job is over" lifts it. `null` — unreachable,
     * unauthenticated, or answering about some other job — leaves it in place,
     * because the alternative reading of silence is "scrobble a queue the
     * worker may still be sending".
     *
     * A `freezing` record is different: it means a tab began a handover and
     * never finished. That tab is gone, and no job exists to ask about, so it
     * is resolved through the handoff it names.
     */
    async reconcileQueueOwner(owner: background.QueueOwner) {
      if (owner.owner === 'freezing') {
        /*
          A freeze that was written moments ago belongs to a tab that is still
          working through its handover. This runs on every load, including in a
          tab the user opened *during* that handover, and clearing the record
          would release every sibling into the window it exists to protect.
          Left alone and reconciled on a later load instead.
        */
        if (background.freezeAttemptIsFresh(owner)) {
          this.backgroundNotice = 'A handover is starting in another tab, so scrobbling here is paused for a moment.';
          return;
        }
        // No handoff id means it never got as far as preflight, so nothing was
        // ever reserved and the freeze can simply lift.
        if (!owner.id) {
          background.releaseQueueOwnerIfSame(owner);
          this.ownershipBlocked = false;
          trackEvent('background_freeze_released', { reason: 'no_handoff' });
          return;
        }
        const active = await background.isHandoffActive(owner.id);
        if (active === false) {
          // Only if the freeze we examined is still the one on record.
          background.releaseQueueOwnerIfSame(owner);
          this.ownershipBlocked = false;
          trackEvent('background_freeze_released', { reason: 'handoff_inactive' });
          return;
        }
        if (active === true) {
          background.setQueueOwner({ owner: 'server', id: owner.id });
        }
        this.backgroundNotice = 'A handover started in another tab and didn\'t finish, so scrobbling here is on hold until we can tell whether it took effect. Please refresh in a few minutes.';
        return;
      }

      const live = await background.hasLiveJob(owner.id);
      if (live === false) {
        // Only if the record we examined is still the one on record.
        background.releaseQueueOwnerIfSame(owner);
        this.ownershipBlocked = false;
        try {
          this.hasResumableState = await this.stateManager.hasSavedState();
        } catch (e) {
          // Nothing to restore the button for.
        }
        trackEvent('background_ownership_released', { reason: 'job_finished' });
        return;
      }
      if (live === null && background.isSessionExpired()) {
        // Sessions last 14 days and jobs can run for five weeks, so this is
        // an expected end state rather than an error. It needs an action, not
        // an apology.
        this.showReauth = true;
        this.backgroundNotice = 'Your link to the background service has expired, so this browser can\'t check whether your import finished. Sign in again to unlock scrobbling here.';
      }
    },

    /**
     * Settles a handoff whose outcome was never established.
     *
     * A previous visit may have uploaded a queue and then lost the finalise
     * response, or failed to clear local state after the server took over. In
     * both cases IndexedDB still holds a queue the worker may be scrobbling,
     * and the ordinary startup path would offer to resume it.
     *
     * Only two answers are acted on. "Active" means the server owns it, so the
     * local copy goes. "Definitively inactive" means it does not, so the user
     * carries on as normal. Anything else — including a network failure —
     * leaves the marker in place and Resume withheld, because at this scale an
     * unnecessary delay is recoverable and a duplicated import is not.
     */
    async resolveOwnership(marker: background.OwnershipMarker) {
      this.showReauth = false;
      // Captured before the round-trip so the release below can prove the
      // record it clears is the one this answer is actually about.
      const observed = background.queueOwner();
      const active = await background.resolveOwnershipMarker(marker);

      if (active === true) {
        /*
          Announced before the clear. A marker left by an older client carries
          no ownership record, so this may be the first moment any tab learns
          the server owns the queue — and a sibling still holding it in memory
          learns nothing from IndexedDB being emptied.
        */
        background.setQueueOwner({ owner: 'server', id: marker.id });
        this.ownershipBlocked = true;
        try {
          await this.stateManager.clearState();
          this.hasResumableState = false;
        } catch (e) {
          /*
            The queue is still on disk and the server is scrobbling it. The
            marker must survive: clearing it here would leave a resumable
            local copy with nothing recording that it is unsafe, which is the
            original duplicate path this whole mechanism exists to close.
          */
          trackError('background.resolveOwnershipClear', e);
          this.hasResumableState = false;
          await this.refreshBackgroundJob();
          this.backgroundNotice = 'Your import is running on the server. This browser could not clear its old copy, so scrobbling here stays off to avoid sending anything twice.';
          trackEvent('background_ownership_resolved', { outcome: 'server_owns_clear_failed' });
          return;
        }
        background.clearOwnershipUnresolved();
        background.clearPendingHandoff();
        await this.refreshBackgroundJob();
        this.backgroundNotice = 'Your import was handed over successfully and is running on the server.';
        trackEvent('background_ownership_resolved', { outcome: 'server_owns' });
        return;
      }

      if (active === false) {
        background.clearOwnershipUnresolved();
        background.clearPendingHandoff();
        // Released origin-wide: this is a definitive "the browser owns it"
        // answer, so other tabs may scrobble again too — but only if the
        // record is still the one this answer was about. Another tab may have
        // established a new freeze while the request was in flight.
        if (observed) {
          background.releaseQueueOwnerIfSame(observed);
        }
        // Cleared alongside the marker: this is a definitive "the browser owns
        // it" answer, so leaving the gate closed would hide a queue we have
        // just proved is safe to resume.
        this.ownershipBlocked = false;
        try {
          this.hasResumableState = await this.stateManager.hasSavedState();
        } catch (e) {
          // Nothing to restore the button for.
        }
        trackEvent('background_ownership_resolved', { outcome: 'client_owns' });
        return;
      }

      // Unresolved. Withhold Resume rather than risk a duplicate import.
      this.hasResumableState = false;
      this.ownershipBlocked = true;
      this.showReauth = background.isSessionExpired();
      this.backgroundNotice = background.isSessionExpired()
        ? 'Your link to the background service has expired, so this browser can\'t check whether it finished your import. Sign in again to unlock scrobbling here.'
        : 'We couldn\'t reach the background service to check whether it took over your import, so scrobbling in this tab is on hold to avoid sending anything twice. Your progress is safe — please refresh in a few minutes.';
      trackEvent('background_ownership_unresolved', { session_expired: background.isSessionExpired() });
    },

    /**
     * Replaces an expired bearer token so the ownership question can be asked
     * again.
     *
     * The block is deliberately *not* lifted here — only the answer that comes
     * back after the redirect may do that.
     */
    async reauthenticate() {
      const username = (this.$store.state.lfmApi as LastFm).getUserName() || '';
      if (!username) {
        this.backgroundNotice = 'Sign in to Last.fm first, then try again.';
        return;
      }
      this.reauthBusy = true;
      trackEvent('background_reauth_started');
      const url = await background.startReauth(username);
      if (!url) {
        this.reauthBusy = false;
        this.backgroundNotice = 'Couldn\'t reach the background service to sign in. Please try again in a few minutes.';
        return;
      }
      window.location.href = url;
    },

    /**
     * Asks the server, once, whether it is actually accepting work.
     *
     * A build-time flag is not enough. The URL is baked into the bundle, but
     * the worker behind it may not be deployed, may be down, or may be full —
     * and a cached bundle outlives any of those. Advertising the feature on
     * the strength of the flag alone would offer users a handoff that dies at
     * the first request, after they had already agreed to it.
     *
     * Failure is silent and simply means "don't offer".
     */
    async probeBackgroundAvailability() {
      if (!background.isBackgroundConfigured() || !background.canCompress()) {
        return;
      }
      /*
        No durable stop, no offer.

        A handover binds every tab, and the only signal that reaches a tab
        opened later — or restored from the bfcache after the broadcast went
        out — is the localStorage record. Without it a sibling reads the queue
        as unowned and scrobbles it alongside the worker, silently, for weeks.
        Declining the feature costs a user with disabled storage nothing they
        had before.
      */
      if (!background.canCoordinateTabs()) {
        trackEvent('background_unavailable', { reason: 'no_durable_storage' });
        return;
      }
      try {
        const capacity = await background.fetchCapacity();
        this.backgroundAvailable = !!capacity && capacity.available;
      } catch (e) {
        this.backgroundAvailable = false;
      }
    },

    /**
     * Opens the offer for a queue the scrobble step is currently working on.
     */
    onBackgroundRequested(info: ProgressSnapshot) {
      if (!this.backgroundAvailable || this.backgroundJob) {
        return;
      }
      const state = this.buildState(info);
      const remaining = uploadListFromState(state, Math.floor(Date.now() / 1000)).length;
      if (!this.canOfferBackground(remaining)) {
        return;
      }
      this.pendingSnapshot = info;
      this.pendingState = null;
      this.backgroundRemaining = remaining;
      this.backgroundAllReTagged = state.tracks.every((t) => t.reTagged);
      this.showBackgroundOffer = true;
      trackEvent('background_offer_shown', {
        entry_point: 'scrobble_step',
        track_count: remaining,
      });
    },

    /**
     * A deliberate "Not now". Distinct from dismissing the dialog, so the
     * decline rate measures people who read the consent copy and said no.
     */
    onBackgroundDeclined() {
      trackEvent('background_offer_declined', {
        entry_point: this.pendingSnapshot ? 'scrobble_step' : 'resume',
        track_count: this.backgroundRemaining,
        all_re_tagged: this.backgroundAllReTagged,
      });
    },

    async startBackgroundHandoff() {
      const step = this.$refs.scrobbleStep as any;

      // Halt the loop *before* anything else. The handoff uploads whatever is
      // remaining right now; every track the loop sends between here and the
      // redirect would be in that upload too, and the server would scrobble it
      // again. This is the single largest duplicate risk in the design.
      this.backgroundBusy = true;
      if (step && step.haltForHandoff) {
        const halted = await step.haltForHandoff();
        if (!halted) {
          // The loop did not stop within the timeout. Handing over now would
          // leave the tab sending tracks that are also in the uploaded list,
          // which is the one outcome worse than not offering the feature.
          this.backgroundBusy = false;
          this.showBackgroundOffer = false;
          step.releaseHandoffHalt();
          this.backgroundNotice = 'Couldn\'t pause this tab\'s scrobbling in time, so the handover was cancelled to avoid sending anything twice. Nothing has changed — try again in a moment.';
          trackEvent('background_handoff_failed', { reason: 'halt_timeout' });
          return;
        }
      }

      // The state is rebuilt *after* the halt, from a live snapshot where
      // there is one, so it describes what is actually left rather than what
      // was left when the dialog opened.
      const snapshot = step && step.progressSnapshot ? step.progressSnapshot() : this.pendingSnapshot;
      const state = snapshot && this.pendingSnapshot
        ? this.buildState(snapshot)
        : this.pendingState;
      if (!state) {
        this.backgroundBusy = false;
        return;
      }

      const username = (this.$store.state.lfmApi as LastFm).getUserName() || state.userName || '';
      const entryPoint = this.pendingSnapshot ? 'scrobble_step' : 'resume';

      // Recorded before the redirect. The saved state is destroyed once the
      // server takes ownership, and it is the only place this lineage lives.
      const handedOverAtSec = Math.floor(Date.now() / 1000);
      /*
        The band this browser's re-tag allocator could have used, banked so a
        later take-back reserves below it rather than through it.

        Recorded only when re-tagging actually happened — every banked band
        costs six hours out of Last.fm's thirteen-day window, and a queue with
        no re-tagged tracks used none of it.

        Where the state carries an explicit reservation that is the exact band;
        otherwise the allocator ran upwards from six hours back, so the six
        hours ending at the handoff bound it.
      */
      const priorLineage = background.getHandoffLineage();
      const usedBand = state.lastReTagTimestampSec
        ? {
          from: state.reTagFloorSec || handedOverAtSec - RETAG_BACKFILL_SECONDS,
          to: state.reTagCeilingSec || handedOverAtSec,
        }
        : null;
      const mergedLineage = background.mergeReTagRange(
        priorLineage ? priorLineage.reTagUsedRanges : [],
        usedBand,
        priorLineage ? priorLineage.reTagKnownFromSec : 0,
      );
      background.setHandoffLineage({
        originalTotalTracks: state.originalTotalTracks || state.totalTracks,
        originalSucceededCount: state.originalSucceededCount || 0,
        reTagCursorSec: state.lastReTagTimestampSec || 0,
        handedOverAtSec,
        reTagUsedRanges: mergedLineage.ranges,
        reTagKnownFromSec: mergedLineage.knownFromSec,
      });

      const result = await beginHandoff(this.stateManager, state, username, entryPoint);
      if (!result.ok) {
        this.backgroundBusy = false;
        this.showBackgroundOffer = false;
        if (step && step.releaseHandoffHalt) {
          step.releaseHandoffHalt();
        }
        this.backgroundNotice = result.reason === 'at_capacity'
          ? 'The background service is full right now — it is limited during the beta. Your progress is saved; try again later or keep scrobbling in this tab.'
          : 'Couldn\'t hand this over to the background service. Your progress is saved and nothing has changed — keep scrobbling in this tab.';
      }
      // On success the tab is navigating to Last.fm; leave `busy` set so the
      // dialog cannot be double-submitted during the redirect.
    },

    /**
     * Undoes the "navigating away" state after a bfcache restore.
     *
     * Handing over deliberately leaves the tab busy and the loop halted while
     * it redirects, so the dialog cannot be submitted twice. A bfcache restore
     * brings that state back with no `mounted()` to undo it, leaving a
     * permanently stuck page.
     *
     * It is tempting to assume that coming *back* means authorisation never
     * happened, so no job can exist. That is false: the user can authorise,
     * land on the callback page, and then press Back far enough to reach this
     * entry — at which point the server owns the queue and this page still
     * holds it in memory. So nothing is released without the server agreeing.
     * Unknown stays halted.
     */
    async recoverFromBfcache() {
      if (!this.backgroundBusy && !this.showBackgroundOffer) {
        return;
      }

      /*
        Absence of a handoff id proves nothing. A *successful* handoff clears
        it — that is the last thing `completeHandoff` does — so the case where
        the server definitely owns the queue looks identical to the case where
        nothing ever started. The server is asked either way.
      */
      const marker = background.getOwnershipUnresolved();
      const pendingId = background.getPendingHandoff();
      let owned: boolean | null;
      if (marker) {
        owned = await background.resolveOwnershipMarker(marker);
      } else if (pendingId) {
        owned = await background.isHandoffActive(pendingId);
      } else {
        owned = await background.hasLiveJob();
      }

      if (owned !== false) {
        // Either the server owns the queue, or we cannot tell. Both mean the
        // loop must stay stopped. Record the ambiguity durably so a reload
        // does not quietly offer Resume instead.
        const fallbackId = (marker && marker.id) || pendingId;
        if (fallbackId) {
          background.setOwnershipUnresolved(marker ? marker.kind : 'handoff', fallbackId);
        }
        // Other tabs are told too. This path is reached from the bfcache, so
        // the freeze this tab set before redirecting may be all that is
        // standing between a sibling and a live job.
        background.setQueueOwner({ owner: 'server', id: fallbackId || '' });
        this.backgroundBusy = false;
        this.showBackgroundOffer = false;
        this.hasResumableState = false;
        this.ownershipBlocked = true;
        await this.refreshBackgroundJob();
        this.backgroundNotice = owned === true
          ? 'Your import was handed over and is running on the server, so scrobbling in this tab is switched off.'
          : 'We couldn\'t check whether the background service took over your import, so scrobbling in this tab is on hold. Please refresh in a few minutes.';
        trackEvent('background_handoff_abandoned', { reason: 'bfcache_restore', resolved: String(owned) });
        return;
      }

      // The server has definitively not taken the queue, so this tab still
      // owns it and can carry on.
      this.backgroundBusy = false;
      this.showBackgroundOffer = false;
      this.ownershipBlocked = false;
      background.clearPendingHandoff();
      background.clearOwnershipUnresolved();
      // Scoped: this tab's own freeze, or a `server` record we have just
      // disproved. A freeze another tab is actively holding stays.
      background.releaseQueueOwnerIfUnclaimed(pendingId || '');
      background.clearHandoffLineage();

      const step = this.$refs.scrobbleStep as any;
      if (step && step.releaseHandoffHalt) {
        step.releaseHandoffHalt();
      }

      this.backgroundNotice = 'The handover wasn\'t completed, so nothing was started. Your progress is still here — carry on in this tab, or try handing it over again.';
      trackEvent('background_handoff_abandoned', { reason: 'bfcache_restore', resolved: 'false' });
    },

    /**
     * Finishes a handoff that Last.fm has just redirected back to us.
     *
     * Returns true when this page load belongs to a handoff, in which case the
     * caller must not touch local state — the upload reads it and the
     * finalise clears it.
     */
    async resumeHandoffIfReturning(): Promise<boolean> {
      const params = new URLSearchParams(window.location.search);
      const handoffParam = params.get('handoff');
      if (!handoffParam) {
        return false;
      }

      if (handoffParam === 'failed') {
        this.backgroundNotice = 'Last.fm didn\'t complete the handoff, so nothing was started. Your progress is still saved here.';
        trackEvent('background_handoff_failed', { reason: params.get('reason') || 'callback' });
        this.stripQuery();
        return false;
      }

      const fragment = background.consumeRedirectFragment();
      const handoffId = (fragment && fragment.handoffId) || background.getPendingHandoff();
      this.stripQuery();
      if (!handoffId) {
        this.backgroundNotice = 'The handoff came back without a session, so nothing was started. Your progress is still saved here.';
        return false;
      }

      this.backgroundBusy = true;
      this.backgroundNotice = 'Uploading your remaining tracks…';
      let result;
      try {
        result = await completeHandoff(this.stateManager, handoffId, (done, total) => {
          this.backgroundNotice = `Uploading your remaining tracks… ${done} of ${total}`;
        });
      } catch (e) {
        trackError('background.completeHandoff', e);
        // An unexpected throw tells us nothing about whether the job started,
        // so this must not fall through to "resume locally".
        this.backgroundBusy = false;
        this.backgroundNotice = 'Something went wrong finishing the handoff, and we can\'t tell whether the background import started. Reload this page in a minute — don\'t resume here in the meantime, or your tracks could be scrobbled twice.';
        return true;
      }
      this.backgroundBusy = false;

      if (result.outcome.status === 'active') {
        this.backgroundNotice = '';
        this.hasResumableState = false;
        await this.refreshBackgroundJob();
        return true;
      }

      if (result.safeToResumeLocally) {
        this.backgroundNotice = 'The upload didn\'t finish, so nothing is running on the server. Your progress is exactly where you left it.';
        return false;
      }

      this.backgroundNotice = 'We can\'t tell whether the background import started. Reload this page in a minute — don\'t resume here in the meantime, or your tracks could be scrobbled twice.';
      return true;
    },

    /**
     * Removes the handoff parameters so a reload does not re-run the flow.
     */
    stripQuery() {
      try {
        window.history.replaceState(null, '', window.location.pathname);
      } catch (e) {
        trackError('background.stripQuery', e);
      }
    },

    async refreshBackgroundJob() {
      this.backgroundJob = await background.fetchJob();
    },

    async pauseBackgroundJob() {
      if (!this.backgroundJob) { return; }
      this.backgroundBusy = true;
      await background.jobAction(this.backgroundJob.id, 'pause');
      await this.refreshBackgroundJob();
      this.backgroundBusy = false;
    },

    async resumeBackgroundJob() {
      if (!this.backgroundJob) { return; }
      this.backgroundBusy = true;
      await background.jobAction(this.backgroundJob.id, 'resume');
      await this.refreshBackgroundJob();
      this.backgroundBusy = false;
    },

    /**
     * Cancels the job and restores what is left of it to this browser.
     *
     * Ordering is the whole correctness argument, and it has to satisfy two
     * opposing constraints at once:
     *
     *   - Cancelling first would be lossy: the cancel deletes the job's blobs,
     *     and the export is built from them.
     *   - Exporting first is racy: the worker keeps scrobbling and advancing
     *     its cursor while the export is in flight, so tracks it sent after
     *     the snapshot are still in the returned queue and would be scrobbled
     *     again locally.
     *
     * So the job is *paused* first, and the export itself refuses to run until
     * the server can see that nothing is in flight — no lease held and no
     * batch in `sending`. Quiescence is a server-side fact, so the server is
     * what decides it; the client only retries until it gets an answer.
     */
    async takeBackProgress() {
      if (!this.backgroundJob) { return; }
      this.backgroundBusy = true;
      const jobId = this.backgroundJob.id;
      /*
        One claim for the whole take-back, not just the export loop.

        The server accepts an export retry only from the claimant, so a fresh
        token per attempt would lock this take-back out of its own claim. The
        cancel at the end presents it too: cancelling deletes the blobs, and
        the server refuses a cancel during an active export unless the caller
        can prove it owns that export.
      */
      const exportClaim = background.newExportClaim();
      try {
        if (!await background.jobAction(jobId, 'pause')) {
          throw new Error('The background import could not be paused.');
        }

        // A Last.fm request can take fifteen seconds, and a batch mid-flight is
        // still after the cursor, so it would be exported *and* sent. The
        // server rejects the export with 409 until that settles.
        const exported = await this.exportWhenQuiescent(jobId, exportClaim);
        const username = (this.$store.state.lfmApi as LastFm).getUserName() || '';
        const restored = stateFromExport(
          exported,
          username,
          this.backgroundJob.totalTracks || 0,
          (this.$store.state.reTagBlockedUntilSec as number) || 0,
        );
        if (!restored) {
          throw new Error('The server did not return your remaining tracks.');
        }
        /*
          The seconds the worker actually used are folded into the lineage
          before anything is cleared. `stateFromExport` only *consults* them to
          pick this cycle's band; once the job is cancelled they exist nowhere
          else, and a second handover would then allocate over them.

          Whatever the export could not fit is carried as a floor rather than
          forgotten, so the next cycle's gap search knows where its knowledge
          stops instead of treating a partial list as exhaustive.
        */
        const priorForCarry = background.getHandoffLineage();
        const carriedLineage = background.mergeExportedRanges(
          priorForCarry ? priorForCarry.reTagUsedRanges : undefined,
          exported.usedRanges,
          priorForCarry ? priorForCarry.reTagKnownFromSec : undefined,
          exported.usedRangesIncomplete
            ? Math.floor(Date.now() / 1000)
            : exported.usedRangesFloorSec,
        );
        // Saved before the job is cancelled. Cancelling first and then failing
        // to save would destroy the only copy of the queue.
        await this.stateManager.saveState(restored);

        /*
          From here until the cancel is confirmed, both sides may believe they
          own the queue: the tracks are on disk locally and the job is still
          alive on the server. Marked durably before the attempt, because if
          the cancel's result is unknown *and* the page is reloaded, nothing
          else would record that ambiguity and Resume would reappear.
        */
        background.setOwnershipUnresolved('job', jobId);

        // Only a *confirmed* cancel releases local ownership. A cancel whose
        // request never arrived leaves the job alive, and showing "Resume"
        // then invites the user to scrobble everything a second time.
        if (!await background.jobAction(jobId, 'cancel', exportClaim)) {
          this.backgroundNotice = 'Your tracks were copied back, but the background import could not be stopped, so this browser will not resume them yet. Use "Take my progress back" again in a moment.';
          await this.refreshBackgroundJob();
          this.backgroundBusy = false;
          return;
        }

        this.backgroundJob = null;
        this.hasResumableState = true;
        this.ownershipBlocked = false;
        // The cancel is confirmed, so the record naming this job is ours to
        // clear — but a freeze another tab is holding for a *different*
        // handover is not.
        background.releaseQueueOwnerIfUnclaimed(jobId);
        background.clearOwnershipUnresolved();
        background.clearPendingHandoff();
        background.clearHandoffLineage(carriedLineage.ranges, carriedLineage.knownFromSec);
        this.backgroundNotice = 'Your remaining tracks are back in this browser. Choose "Resume" to carry on here.';
        trackEvent('background_job_reclaimed', { job_id: jobId });
      } catch (e) {
        trackError('background.takeBackProgress', e);
        // The job may have been left paused. Say so, and re-read its real
        // state rather than leaving a stale banner on screen.
        await this.refreshBackgroundJob();
        this.errorMessage = 'Couldn\'t bring your progress back. Your tracks are still safe on the server — nothing has been lost or scrobbled twice.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
      }
      this.backgroundBusy = false;
    },

    /**
     * Exports a paused job, waiting for the server to agree it is safe.
     *
     * The server returns 409 while a lease is held or a batch is still in
     * `sending`, because those tracks are both after the cursor (so they would
     * be exported) and in flight to Last.fm (so they would also be scrobbled).
     * Only the server can see either condition.
     *
     * A `null`/error result is a *failure*, never proof of quiescence — the
     * previous version inferred quiescence from a status call returning
     * nothing, which reads an unreachable server as "the job is gone".
     */
    async exportWhenQuiescent(jobId: string, claim: string): Promise<any> {
      let lastReason = 'unreachable';
      /*
        Budgeted to outlast a lease *and* a missed sweep.

        A tick that sees the pause between batches returns without releasing,
        so its lease can stand for the full 180 seconds. Beyond that, a batch
        left `sending` can only be settled by a drain — which the export
        endpoint now asks for directly, but which refuses to touch a batch
        inside its 120-second grace period. 120 retries at 3 seconds covers
        the lease, the grace period and a slow request each time round,
        without which a perfectly normal stop is reported as a failure.
      */
      for (let i = 0; i < 120; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const exported = await background.exportJob(jobId, claim);
        if (exported && exported.ok) {
          return exported;
        }
        lastReason = (exported && exported.detail) || 'unreachable';
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => { setTimeout(resolve, 3000); });
      }
      throw new Error(`The background import did not stop in time (${lastReason}).`);
    },

    /**
     * AuthenticateStep confirms an existing session and then emits `complete`
     * on a 2 second delay (so the "Checking for authentication..." spinner is
     * readable). The user can act inside that window — most importantly they can
     * hit "Resume", which jumps straight to the scrobble step. Advancing
     * unconditionally would then yank them back to the upload step a moment
     * later, losing the resumed session. Only ever move *forward* off step 1.
     */
    onAuthenticated() {
      if (this.currentStep === 1) {
        this.currentStep = 2;
      }
      /*
        The username is only knowable now, so for a browser that arrived
        without one — cleared storage, a new device, a fresh profile — this is
        the first moment the server can be asked about them at all. That is
        exactly the browser holding no local record of a handover, so skipping
        the check here would leave the case it was built for uncovered.

        `authorityPending` is raised *synchronously*, before the await inside
        the check can yield. This component deliberately supports the user
        pressing Resume during the two-second authentication transition, so
        leaving the flag down until the request resolved would leave Resume
        live across exactly the window the check is meant to cover.
      */
      this.authorityPending = true;
      this.enforceServerAuthority().catch(() => {
        // Leaves local records as they were, but never leaves the gate open on
        // an unanswered question.
        this.authorityPending = false;
        this.authorityUnknown = true;
        this.scheduleAuthorityRetry();
      });
    },
    /**
     * `state.totalTracks` is only the tracks left to do, so on its own it makes
     * a resumed import look smaller each time. Always report the original size
     * and the cumulative progress alongside it.
     */
    resumeProps(state: ScrobbleState, source: string) {
      const originalTotal = state.originalTotalTracks || state.totalTracks;
      const succeeded = state.originalSucceededCount ?? state.completedIndices.length;
      return {
        source,
        total_tracks: state.totalTracks,
        original_total_tracks: originalTotal,
        total_succeeded: succeeded,
        completion_pct: originalTotal
          ? Math.round((1000 * succeeded) / originalTotal) / 10
          : 0,
      };
    },
    clearToken() {
      const api = this.$store.state.lfmApi as LastFm;
      this.currentStep = 1;
      api.clearUser();
      resetUser();
      trackEvent('user_logged_out');
    },
    async resumeFromSaved() {
      /*
        Checked here as well as in the template. The alert is one route to
        this; a resumed session also arrives from the ownership listener and
        from the import-file path, and a hidden button is not a guarantee that
        the method cannot run. This is the action that begins sending, so it
        carries its own refusal rather than trusting the view.
      */
      if (this.authorityPending || this.authorityUnknown || this.ownershipBlocked) {
        this.backgroundNotice = 'Hold on — still checking whether an import is already running on the server for your account.';
        return;
      }
      try {
        const state = await this.stateManager.loadState();
        if (!state) { return; }
        trackEvent('session_resumed', this.resumeProps(state, 'saved'));
        this.restoreFromState(state);
      } catch (e) {
        trackError('scrobblify.resumeFromSaved', e);
        this.errorMessage = 'Failed to load your saved progress.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
      }
    },
    importStateFile() {
      (this.$refs.importFileInput as HTMLInputElement).click();
    },
    async onImportFile(event: Event) {
      const input = event.target as HTMLInputElement;
      if (!input.files || input.files.length === 0) { return; }
      try {
        const state = await this.stateManager.importFromFile(input.files[0]);
        trackEvent('session_resumed', this.resumeProps(state, 'file'));
        this.restoreFromState(state);
      } catch (e) {
        trackError('scrobblify.onImportFile', e);
        this.errorMessage = 'The selected file is not a valid Scrobblify progress file.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
      }
    },
    restoreFromState(state: ScrobbleState) {
      const api = this.$store.state.lfmApi as LastFm;
      if (state.userName && api.getUserName() && api.getUserName() !== state.userName) {
        this.errorMessage = `This saved state is for Last.fm user "${state.userName}" but you are logged in as "${api.getUserName()}". Please log in as the correct user.`;
        this.showError = true;
        return;
      }

      this.restoreRateLimitWindow(state, api.getUserName() || state.userName || null);
      this.$store.commit('setReTagCursorSec', state.lastReTagTimestampSec || 0);
      this.$store.commit('setReTagReservedRange', {
        floorSec: state.reTagFloorSec || 0,
        ceilingSec: state.reTagCeilingSec || 0,
      });
      this.$store.commit('setReTagBlocked', state.reTagBlockedUntilSec || 0);
      /*
        Restored *before* the queue, so the first track of the resumed run is
        retried with the second it may already have been sent under. Absent for
        every state saved while nothing was in flight, which is almost all of
        them.
      */
      this.$store.commit('setPendingReTagSec', state.pendingReTagTimestampSec || 0);

      // Restore remaining (not yet completed) tracks to store
      const allScrobbles = StateManager.deserializeScrobbles(state.tracks);
      const completedSet = new Set(state.completedIndices);
      const failedSet = new Set(state.failedIndices);
      const remaining = allScrobbles.filter((_, i) => !completedSet.has(i) && !failedSet.has(i));

      this.$store.commit('setSelectedScrobbles', remaining);
      // The scrobble step only ever sees the remaining tracks, so it needs to be
      // told separately that this is a resume — otherwise `scrobble_resumed`
      // can never fire and the resume funnel is invisible. `originalTotalTracks`
      // likewise has to be carried forward, since `remaining.length` shrinks on
      // every resume and would otherwise make completion look better each time.
      this.$store.commit('setResumedScrobbleCount', state.originalSucceededCount ?? completedSet.size);
      this.$store.commit('setOriginalTotalTracks', state.originalTotalTracks || state.totalTracks);
      this.hasResumableState = false;
      // Skip to scrobble step (step 4)
      this.currentStep = 4;

      // A resume of this size is the clearest signal that the browser is the
      // wrong place to be doing this: the user has already come back at least
      // once and still has weeks of it ahead.
      this.offerBackgroundForState(state, 'resume');
    },

    /**
     * Offers background mode for an already-built state, if it qualifies.
     */
    offerBackgroundForState(state: ScrobbleState, entryPoint: string) {
      // Cheap gates first. `uploadListFromState` deserialises and sorts the
      // whole queue, which on a six-figure import is real work to do on the
      // resume path — and pointless when the feature is off or a server job
      // already owns these tracks.
      if (!this.backgroundAvailable || this.backgroundJob) {
        return;
      }
      const remaining = uploadListFromState(state, Math.floor(Date.now() / 1000)).length;
      if (!this.canOfferBackground(remaining)) {
        return;
      }
      // The offer needs a snapshot it can rebuild the state from at accept
      // time. Everything it needs is already in `state`, so reuse it directly
      // rather than reconstructing a ProgressSnapshot that would lose the
      // completed/failed index sets.
      this.pendingSnapshot = null;
      this.pendingState = state;
      this.backgroundRemaining = remaining;
      this.backgroundAllReTagged = state.tracks.every((t) => t.reTagged);
      this.showBackgroundOffer = true;
      trackEvent('background_offer_shown', { entry_point: entryPoint, track_count: remaining });
    },

    /**
     * Rate-limit budget is a property of the Last.fm *account*, not of a page
     * load, so a restored session must restore it too. Files written before
     * this existed only carry counts, which are converted to a (pessimistic)
     * rolling window.
     */
    restoreRateLimitWindow(state: ScrobbleState, userName: string | null) {
      try {
        const tracker = new RateLimitTracker(userName);
        if (Array.isArray(state.sendTimestamps) && state.sendTimestamps.length > 0) {
          tracker.setSendTimestamps(state.sendTimestamps);
        } else if (state.burstCount || state.dailyCount) {
          const savedAtMs = state.savedAt ? new Date(state.savedAt).getTime() : Date.now();
          tracker.seedFromLegacyCounts(state.burstCount, state.dailyCount, savedAtMs);
        }
      } catch (e) {
        // A missing/corrupt rate-limit record must never block a restore; the
        // tracker simply starts from an empty window.
      }
    },
    async clearSavedState() {
      try {
        await this.stateManager.clearState();
      } catch (e) {
        // Not critical — continue anyway
      }
      this.hasResumableState = false;
    },
    async onScrobbleComplete() {
      try {
        await this.stateManager.clearState();
      } catch (e) {
        // Not critical — continue anyway
      }
      this.$store.commit('setResumedScrobbleCount', 0);
      this.hasRemainingTracks = false;
      this.currentStep = 5;
    },
    buildState(info: ProgressSnapshot): ScrobbleState {
      const tracks = this.$store.state.selectedScrobbles as Scrobble[];
      const completedIndices: number[] = [];
      const failedIndices: number[] = [];
      for (let i = 0; i < info.scrobbledTracks; i++) {
        completedIndices.push(i);
      }

      return {
        userName: (this.$store.state.lfmApi as LastFm).getUserName() || '',
        totalTracks: tracks.length,
        completedIndices,
        failedIndices,
        tracks: StateManager.serializeScrobbles(tracks),
        originalTotalTracks: info.originalTotalTracks || tracks.length,
        originalSucceededCount: info.originalSucceededCount,
        sendTimestamps: info.sendTimestamps || [],
        lastReTagTimestampSec: info.lastReTagTimestampSec || 0,
        /*
          Carried through every save so a reserved range survives pause/resume
          cycles. Losing it would silently return the allocator to the shared
          six-hour window and reintroduce the overlap with the server's range.
        */
        ...((this.$store.state.reTagFloorSec as number)
          ? {
            reTagFloorSec: this.$store.state.reTagFloorSec as number,
            reTagCeilingSec: this.$store.state.reTagCeilingSec as number,
          }
          : {}),
        // Carried for the same reason, and more urgently: dropping this one
        // does not merely widen the search, it re-enables re-tagging that was
        // established to be unsafe.
        ...((this.$store.state.reTagBlockedUntilSec as number)
          ? { reTagBlockedUntilSec: this.$store.state.reTagBlockedUntilSec as number }
          : {}),
        /*
          The in-flight synthetic second, when there is one. Taken from the
          snapshot rather than the store because it belongs to a specific
          track — the one now at the head of the remaining queue — and the
          snapshot is what fixes which track that is.
        */
        ...(info.pendingReTagTimestampSec
          ? { pendingReTagTimestampSec: info.pendingReTagTimestampSec }
          : {}),
        burstCount: info.burstCount,
        dailyCount: info.dailyCount,
        dailyCountDate: new Date().toISOString().split('T')[0],
        savedAt: new Date().toISOString(),
      };
    },
    saveProps(info: ProgressSnapshot, automatic: boolean) {
      const originalTotal = info.originalTotalTracks
        || (this.$store.state.selectedScrobbles as Scrobble[]).length;
      return {
        automatic,
        scrobbled_tracks: info.scrobbledTracks,
        total_tracks: (this.$store.state.selectedScrobbles as Scrobble[]).length,
        original_total_tracks: originalTotal,
        total_succeeded: info.originalSucceededCount,
        completion_pct: originalTotal
          ? Math.round((1000 * info.originalSucceededCount) / originalTotal) / 10
          : 0,
      };
    },
    /**
     * Silent save used when the scrobble step gives up (rate limited or daily
     * limit reached). No file download and no navigation: the user stays on the
     * explanation and can simply close the tab and come back.
     */
    async onAutoSave(info: ProgressSnapshot) {
      try {
        await this.stateManager.saveState(this.buildState(info));
        trackEvent('session_saved', this.saveProps(info, true));
      } catch (e) {
        trackError('scrobblify.onAutoSave', e);
        /*
          Reported *and* rethrown. Callers that merely want a best-effort save
          catch it and carry on, but the halt path awaits this to decide
          whether the queue on disk is safe for a sibling to upload — and a
          rejection that has been swallowed here is indistinguishable from a
          write that landed. That is precisely the confusion that lets a freeze
          read stale progress and hand already-sent tracks to the worker.
        */
        throw e;
      }
    },
    /**
     * Durable save that refuses to move progress backwards.
     *
     * Used by halts, where several tabs persist within milliseconds of each
     * other and a plain `put` would let the slowest one erase the furthest
     * progress. See `StateManager.saveStateIfAhead`.
     */
    async onAutoSaveIfAhead(info: ProgressSnapshot) {
      try {
        await this.stateManager.saveStateIfAhead(this.buildState(info));
        trackEvent('session_saved', this.saveProps(info, true));
      } catch (e) {
        trackError('scrobblify.onAutoSaveIfAhead', e);
        throw e;
      }
    },
    /**
     * The `auto-save` *event* handler.
     *
     * An emit gives the child nothing to await, so it cannot act on a failure
     * and a rejection here would only surface as an unhandled one. The props
     * above are the channel that carries failure; this stays best-effort.
     */
    onAutoSaveBestEffort(info: ProgressSnapshot) {
      this.onAutoSave(info).catch(() => { /* already reported by onAutoSave */ });
    },
    async onSaveAndExit(info: ProgressSnapshot) {
      const state = this.buildState(info);

      try {
        await this.stateManager.saveState(state);
        this.stateManager.exportToFile(state);
        trackEvent('session_saved', this.saveProps(info, false));
      } catch (e) {
        trackError('scrobblify.onSaveAndExit', e);
        this.errorMessage = 'Failed to save your scrobbling progress. You can try the "Save Progress" button again.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
        return;
      }
      this.hasRemainingTracks = true;
      this.currentStep = 5;
    },
  },
});
</script>
