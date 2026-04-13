<template>
  <div>
    <h1>Authorize the Scrobblify application with last.fm</h1>
    <a href="http://www.last.fm/api/auth/?api_key=2bf354b70b4a9a8a4420b2c48333d23e&cb=https://savas.ca/scrobblify/scrobble">Click here to authorize</a>

    <div v-if="checkingAuth">
      <v-progress-circular indeterminate color="primary">
      </v-progress-circular>
      Checking for authentication...
    </div>
    <error-dialog v-model="showError" :message="errorMessage" :details="errorDetails"></error-dialog>
  </div>
</template>
<style>

</style>
<script lang="ts">
import Vue from 'vue';
import LastFm from '@/api/LastFm';
import ErrorDialog from '@/components/ErrorDialog.vue';
export default Vue.extend({
  components: { 'error-dialog': ErrorDialog },
  data() {
    return {
      checkingAuth: false,
      showError: false,
      errorMessage: '',
      errorDetails: '',
    };
  },
  methods: {
    finishStep() {
      this.$emit('complete');
    },
  },
  async mounted() {
    this.$data.checkingAuth = true;
    const api = this.$store.state.lfmApi as LastFm;
    try {
      await api.init(this.$route.query);
    } catch (e) {
      this.$data.checkingAuth = false;
      this.errorMessage = 'Failed to authenticate with Last.fm. Please try again.';
      this.errorDetails = (e as Error).message || String(e);
      this.showError = true;
      return;
    }
    if (api.isAuthenticated()) {
      setTimeout(() => {
        this.$emit('complete');
      }, 2000);
    } else {
      this.$data.checkingAuth = false;
    }
  },
});
</script>
