<template>
  <div class="scrobblify">
    <div v-if="currentStep > 1">
      Currently authenticated as: {{ this.$store.state.lfmApi.userName }}. <a @click="clearToken">Not you?</a>
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
          <authenticate-step v-on:complete="currentStep = 2"></authenticate-step>
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
          ></scrobble-step>
        </v-stepper-content>
        <v-stepper-content step="5">
          <complete-step :has-remaining="hasRemainingTracks"></complete-step>
        </v-stepper-content>
      </v-stepper-items>
    </v-stepper>
  </div>
</template>
<style>
</style>
<script lang="ts">
import Vue from 'vue';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble from '@/models/Scrobble';
import Bluebird from 'bluebird';
import Scrobblify from '@/scrobblify';

// Steps
import AuthenticateStepVue from '@/components/AuthenticateStep.vue';
import SelectStepVue from '@/components/SelectStep.vue';
import UploadStepVue from '@/components/UploadStep.vue';
import LastFm from '@/api/LastFm';
import ScrobbleStepVue from '@/components/ScrobbleStep.vue';
import CompleteStepVue from '@/components/CompleteStep.vue';
import StateManager, { ScrobbleState } from '@/services/StateManager';


export default Vue.extend({
  components: {
    'authenticate-step': AuthenticateStepVue,
    'upload-step': UploadStepVue,
    'select-step': SelectStepVue,
    'scrobble-step': ScrobbleStepVue,
    'complete-step': CompleteStepVue,
  },
  data() {
    return {
      currentStep: 1,
      hasResumableState: false,
      hasRemainingTracks: false,
      stateManager: new StateManager(),
    };
  },
  async mounted() {
    this.hasResumableState = await this.stateManager.hasSavedState();
  },
  methods: {
    clearToken() {
      const api = this.$store.state.lfmApi as LastFm;
      this.currentStep = 1;
      api.clearUser();
    },
    async resumeFromSaved() {
      const state = await this.stateManager.loadState();
      if (!state) { return; }
      this.restoreFromState(state);
    },
    importStateFile() {
      (this.$refs.importFileInput as HTMLInputElement).click();
    },
    async onImportFile(event: Event) {
      const input = event.target as HTMLInputElement;
      if (!input.files || input.files.length === 0) { return; }
      try {
        const state = await this.stateManager.importFromFile(input.files[0]);
        this.restoreFromState(state);
      } catch (e) {
        alert(`Invalid state file: ${(e as Error).message}`);
      }
    },
    restoreFromState(state: ScrobbleState) {
      const api = this.$store.state.lfmApi as LastFm;
      if (api.getUserName() && api.getUserName() !== state.userName) {
        alert(`This saved state is for Last.fm user "${state.userName}" but you are logged in as "${api.getUserName()}". Please log in as the correct user.`);
        return;
      }

      // Restore remaining (not yet completed) tracks to store
      const allScrobbles = StateManager.deserializeScrobbles(state.tracks);
      const completedSet = new Set(state.completedIndices);
      const failedSet = new Set(state.failedIndices);
      const remaining = allScrobbles.filter((_, i) => !completedSet.has(i) && !failedSet.has(i));

      this.$store.commit('setSelectedScrobbles', remaining);
      this.hasResumableState = false;
      // Skip to scrobble step (step 4)
      this.currentStep = 4;
    },
    async clearSavedState() {
      await this.stateManager.clearState();
      this.hasResumableState = false;
    },
    async onScrobbleComplete() {
      await this.stateManager.clearState();
      this.hasRemainingTracks = false;
      this.currentStep = 5;
    },
    async onSaveAndExit(info: { scrobbledTracks: number, burstCount: number, dailyCount: number }) {
      const tracks = this.$store.state.selectedScrobbles as Scrobble[];
      const completedIndices: number[] = [];
      const failedIndices: number[] = [];
      for (let i = 0; i < info.scrobbledTracks; i++) {
        completedIndices.push(i);
      }

      const state: ScrobbleState = {
        userName: (this.$store.state.lfmApi as LastFm).getUserName() || '',
        totalTracks: tracks.length,
        completedIndices,
        failedIndices,
        tracks: StateManager.serializeScrobbles(tracks),
        burstCount: info.burstCount,
        dailyCount: info.dailyCount,
        dailyCountDate: new Date().toISOString().split('T')[0],
        savedAt: new Date().toISOString(),
      };

      await this.stateManager.saveState(state);
      this.stateManager.exportToFile(state);
      this.hasRemainingTracks = true;
      this.currentStep = 5;
    },
  },
});
</script>

