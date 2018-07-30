<template>
  <div class="scrobblify">
    <div v-if="currentStep > 1">
      Currently authenticated as: {{ this.$store.state.lfmApi.userName }}. <a @click="clearToken">Not you?</a>
    </div>
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
          <scrobble-step v-on:complete="currentStep = 5"></scrobble-step>
        </v-stepper-content>
        <v-stepper-content step="5">
          <complete-step></complete-step>
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
    };
  },
  async created() {
    const api = this.$store.state.lfmApi as LastFm;
    await api.init(this.$route.query);
    if (api.isAuthenticated()) {
      this.currentStep = 2;
    }
  },
  methods: {
    clearToken() {
      const api = this.$store.state.lfmApi as LastFm;
      this.currentStep = 1;
      api.clearUser();
    },
  },
});
</script>

