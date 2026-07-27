<template>
  <div class="scrobblify">
    <div v-if="currentStep > 1">
      Currently authenticated as: {{ this.$store.state.lfmApi.userName }}.
      <a role="button" tabindex="0" @click="clearToken" @keydown.enter="clearToken">Not you?</a>
    </div>
    <v-alert v-if="hasResumableState && currentStep <= 2" type="info" prominent class="mb-4">
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
            v-on:complete="onScrobbleComplete"
            v-on:save-and-exit="onSaveAndExit"
            v-on:auto-save="onAutoSave"
          ></scrobble-step>
        </v-stepper-content>
        <v-stepper-content step="5">
          <complete-step :has-remaining="hasRemainingTracks"></complete-step>
        </v-stepper-content>
      </v-stepper-items>
    </v-stepper>
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
    };
  },
  async mounted() {
    trackEvent('step_viewed', { step: this.currentStep, step_name: this.stepName(this.currentStep) });
    try {
      this.hasResumableState = await this.stateManager.hasSavedState();
    } catch (e) {
      // IndexedDB not available — not critical, just skip resume
    }
  },
  watch: {
    currentStep(step: number) {
      trackEvent('step_viewed', { step, step_name: this.stepName(step) });
    },
  },
  methods: {
    stepName(step: number): string {
      return ['', 'authenticate', 'upload', 'select', 'scrobble', 'complete'][step] || String(step);
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
