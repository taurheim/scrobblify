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
import { trackEvent, trackError, identifyUser } from '@/services/Analytics';
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
    const hadToken = !!this.$route.query.token;
    try {
      await api.init(this.$route.query);
    } catch (e) {
      trackError('auth.init', e);
      trackEvent('auth_failed');
      this.$data.checkingAuth = false;
      this.errorMessage = 'Failed to authenticate with Last.fm. Please try again.';
      this.errorDetails = (e as Error).message || String(e);
      this.showError = true;
      return;
    } finally {
      // Last.fm auth tokens are single-use (consumed by auth.getSession). Strip
      // the token from the URL once we've attempted the exchange so a page
      // refresh or re-navigation never resubmits a consumed token, which Last.fm
      // rejects with error 4 "Unauthorized Token - This token has not been issued".
      if (hadToken) {
        const query = { ...this.$route.query };
        delete query.token;
        this.$router.replace({ query }).catch((err: any) => {
          if (err && err.name !== 'NavigationDuplicated') {
            trackError('auth.strip_token_url', err);
          }
        });
      }
    }
    if (api.isAuthenticated()) {
      identifyUser(api.getUserName());
      trackEvent('auth_success', { returning: !hadToken });
      setTimeout(() => {
        this.$emit('complete');
      }, 2000);
    } else {
      this.$data.checkingAuth = false;
    }
  },
});
</script>
