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
<style>

</style>
<script lang="ts">
import { defineComponent } from 'vue';
import LastFm from '@/api/LastFm';
import ErrorDialog from '@/components/ErrorDialog.vue';
import { trackEvent, trackError, identifyUser } from '@/services/Analytics';
import { HOME_DISMISSED_KEY } from '@/services/ReturningVisitor';

export default defineComponent({
  components: { 'error-dialog': ErrorDialog },
  emits: {
    /**
     * Signed in. `fresh` says whether this load arrived with a callback
     * `?token=`, not whether exchanging it worked: if the exchange fails while
     * a key is stored, the stored key is kept and this still says `true`.
     */
    complete: (payload: { fresh: boolean }) => typeof payload.fresh === 'boolean',
  },
  data() {
    return {
      checkingAuth: false,
      /** Whether this load arrived with a callback `?token=` to exchange. */
      hadToken: false,
      tokenExpired: false,
      showError: false,
      errorMessage: '',
      errorDetails: '',
    };
  },
  computed: {
    authorizeUrl(): string {
      return (this.$store.state.lfmApi as LastFm).getAuthorizeUrl();
    },
  },
  async mounted() {
    this.hadToken = !!this.$route.query.token;
    const { hadToken } = this;
    this.$data.checkingAuth = true;
    const api = this.$store.state.lfmApi as LastFm;
    try {
      await api.init(this.$route.query);
    } catch (e) {
      this.$data.checkingAuth = false;
      trackError('auth.init', e);
      // A dead/expired token (already consumed, unauthorized, or expired) isn't a
      // failure the user can fix by retrying the same link — the only recovery is
      // to authorize again for a fresh token. Show a dedicated, non-alarming
      // recovery prompt instead of the generic error dialog.
      if (LastFm.isAuthTokenError(e)) {
        trackEvent('auth_token_invalid');
        this.tokenExpired = true;
        return;
      }
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
        // Vue Router 4 resolves (rather than rejects) aborted or duplicated
        // navigations, so anything caught here is a genuine error.
        this.$router.replace({ query }).catch((err: unknown) => {
          trackError('auth.strip_token_url', err);
        });
      }
    }
    if (api.isAuthenticated()) {
      identifyUser(api.getUserName());
      trackEvent('auth_success', { returning: !hadToken });
      if (hadToken) {
        // A fresh sign-in may be someone else: Home's "Not you?" shouldn't outlast it.
        try {
          sessionStorage.removeItem(HOME_DISMISSED_KEY);
        } catch {
          // Storage refused; the card just stays hidden for this tab.
        }
      }
      this.$data.checkingAuth = false;
      this.$emit('complete', { fresh: hadToken });
    } else {
      this.$data.checkingAuth = false;
    }
  },
});
</script>
