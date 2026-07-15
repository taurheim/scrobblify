<template>
  <div>
    <h1>Authorize the Scrobblify application with last.fm</h1>
    <a :href="authorizeUrl">Click here to authorize</a>

    <div v-if="checkingAuth">
      <v-progress-circular indeterminate color="primary">
      </v-progress-circular>
      Checking for authentication...
    </div>

    <v-alert v-if="tokenExpired" type="warning" prominent class="mt-4">
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
<style>

</style>
<script lang="ts">
import Vue from 'vue';
import LastFm from '@/api/LastFm';
import ErrorDialog from '@/components/ErrorDialog.vue';
import { trackEvent, trackError, identifyUser } from '@/services/Analytics';

const LFM_API_KEY = '2bf354b70b4a9a8a4420b2c48333d23e';
const LFM_AUTH_CALLBACK = 'https://savas.ca/scrobblify/scrobble';

export default Vue.extend({
  components: { 'error-dialog': ErrorDialog },
  data() {
    return {
      checkingAuth: false,
      tokenExpired: false,
      showError: false,
      errorMessage: '',
      errorDetails: '',
    };
  },
  computed: {
    authorizeUrl(): string {
      return `http://www.last.fm/api/auth/?api_key=${LFM_API_KEY}&cb=${LFM_AUTH_CALLBACK}`;
    },
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
      this.$data.checkingAuth = false;
      // A dead/expired token (already consumed, unauthorized, or expired) isn't a
      // failure the user can fix by retrying the same link — the only recovery is
      // to authorize again for a fresh token. Show a dedicated, non-alarming
      // recovery prompt instead of the generic error dialog.
      if (LastFm.isAuthTokenError(e)) {
        trackError('auth.init', e);
        trackEvent('auth_token_invalid');
        this.tokenExpired = true;
        return;
      }
      trackError('auth.init', e);
      trackEvent('auth_failed');
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
