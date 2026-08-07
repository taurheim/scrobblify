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
    </v-alert>

    <v-alert
      v-if="hasResumableState && currentStep <= 2 && !backgroundJob"
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
            v-on:complete="onScrobbleComplete"
            v-on:save-and-exit="onSaveAndExit"
            v-on:auto-save="onAutoSave"
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

interface ProgressSnapshot {
  scrobbledTracks: number;
  originalTotalTracks: number;
  originalSucceededCount: number;
  sendTimestamps: number[];
  lastReTagTimestampSec: number;
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
    };
  },
  async mounted() {
    trackEvent('step_viewed', { step: this.currentStep, step_name: this.stepName(this.currentStep) });

    // Ordering matters. A handoff coming back from Last.fm must be finished
    // before anything reads local state, because the upload derives its bytes
    // from that state and completing the handoff is what clears it.
    const resumed = await this.resumeHandoffIfReturning();
    if (resumed) {
      return;
    }

    await this.refreshBackgroundJob();

    /*
      Local state first, network second. `hasResumableState` is what puts the
      Resume button on screen, and it is answered by IndexedDB in milliseconds;
      awaiting a capacity probe before it would hold the button back for as
      long as the network takes to fail. Background mode is an enhancement, so
      it resolves whenever it resolves.
    */
    try {
      this.hasResumableState = await this.stateManager.hasSavedState();
    } catch (e) {
      // IndexedDB not available — not critical, just skip resume
    }

    this.probeBackgroundAvailability();
  },
  watch: {
    currentStep(step: number) {
      trackEvent('step_viewed', { step, step_name: this.stepName(step) });
    },
  },
  computed: {
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
        await step.haltForHandoff();
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
     * The export is fetched *before* the cancel and the local state is written
     * *before* the server is told to stop, so a failure at any point leaves the
     * job running rather than leaving the user with nothing.
     */
    async takeBackProgress() {
      if (!this.backgroundJob) { return; }
      this.backgroundBusy = true;
      const jobId = this.backgroundJob.id;
      try {
        const exported = await background.exportJob(jobId);
        const username = (this.$store.state.lfmApi as LastFm).getUserName() || '';
        const restored = stateFromExport(
          exported,
          username,
          this.backgroundJob.totalTracks || 0,
        );
        if (!restored) {
          throw new Error('The server did not return your remaining tracks.');
        }
        // Saved before the job is cancelled. Cancelling first and then failing
        // to save would destroy the only copy of the queue.
        await this.stateManager.saveState(restored);
        await background.jobAction(jobId, 'cancel');
        this.backgroundJob = null;
        this.hasResumableState = true;
        this.backgroundNotice = 'Your remaining tracks are back in this browser. Choose "Resume" to carry on here.';
        trackEvent('background_job_reclaimed', { job_id: jobId });
      } catch (e) {
        trackError('background.takeBackProgress', e);
        this.errorMessage = 'Couldn\'t bring your progress back. The background import is still running, so nothing has been lost.';
        this.errorDetails = (e as Error).message || String(e);
        this.showError = true;
      }
      this.backgroundBusy = false;
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
      }
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
