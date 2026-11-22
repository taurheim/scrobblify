<template>
  <div class="home">
    <h1 class="home-title">Retroactively scrobble Spotify plays to last.fm</h1>

    <home-get-export v-if="gettingExport" @back="gettingExport = false" />

    <div v-else-if="!ready" class="home-loading-wrap">
      <v-progress-circular indeterminate color="primary" class="home-loading" aria-label="Loading" />
    </div>

    <home-returning
      v-else-if="returning.kind !== 'none' && !dismissedReturning"
      :state="returning"
      @continue="continueSaved"
      @start-over="openScrobble"
      @upload="openScrobble"
      @not-you="notYou"
      @show-get-export="showGetExport"
    />

    <template v-else>
      <div class="home-cards">
        <v-card class="home-card">
          <v-card-title class="text-wrap">Already got your streaming history zip?</v-card-title>
          <v-card-actions>
            <v-btn color="primary" variant="flat" block @click="go('have_export')">Start</v-btn>
          </v-card-actions>
        </v-card>
        <v-card class="home-card">
          <v-card-title class="text-wrap">Don't have it yet?</v-card-title>
          <v-card-actions>
            <v-btn color="primary" variant="flat" block @click="showGetExport">Show me how</v-btn>
          </v-card-actions>
        </v-card>
      </div>
      <p class="home-already">
        Already scrobbling on scrobblify?
        <button type="button" class="link-button" :disabled="lookingUp" @click="go('resume')">
          Re-connect to last.fm
        </button>
      </p>
    </template>
  </div>
</template>

<style>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 5%;
}

.home-title {
  margin: 8px 0 24px;
}

.home-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 600px) {
  .home-cards {
    grid-template-columns: 1fr;
  }
}

.home-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.home-already {
  margin-top: 24px;
}

.home-loading-wrap {
  display: flex;
  justify-content: center;
}
</style>

<script lang="ts">
import { defineComponent, markRaw } from 'vue';
import LastFm from '@/api/LastFm';
import HomeGetExport from '@/components/home/HomeGetExport.vue';
import HomeReturning from '@/components/home/HomeReturning.vue';
import StateManager from '@/services/StateManager';
import {
  detectReturning, HOME_DISMISSED_KEY, ReturningState, sameUser,
} from '@/services/ReturningVisitor';
import { resetUser, trackEvent } from '@/services/Analytics';
import { setSignInIntent, startSignIn } from '@/services/SignInIntent';
import {
  isBackgroundConfigured, setWorkerLookup, startReauth,
} from '@/services/BackgroundScrobbling';

type HomeChoice = 'have_export' | 'get_export' | 'resume';

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(HOME_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    sessionStorage.setItem(HOME_DISMISSED_KEY, '1');
  } catch {
    // Private modes can refuse storage; the in-component flag still holds.
  }
}

export default defineComponent({
  components: { 'home-get-export': HomeGetExport, 'home-returning': HomeReturning },
  data() {
    return {
      // Nothing renders until the returning check settles, so a returning
      // visitor never sees the first-visit page flash first.
      ready: false,
      gettingExport: false,
      dismissedReturning: false,
      returning: { kind: 'none' } as ReturningState,
      stateManager: markRaw(new StateManager()),
      /** "Re-connect" is asking the worker for its sign-in link. */
      lookingUp: false,
      onPageShow: null as ((event: PageTransitionEvent) => void) | null,
    };
  },
  async mounted() {
    // A lookup only ever starts here, so one still flagged is from a trip to
    // Last.fm the user came back from without finishing.
    setWorkerLookup(false);
    // Pressing Back on Last.fm can restore this page as it was left.
    this.onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        this.lookingUp = false;
        setWorkerLookup(false);
      }
    };
    window.addEventListener('pageshow', this.onPageShow);
    this.dismissedReturning = readDismissed();
    await this.refreshReturning();
  },
  beforeUnmount() {
    if (this.onPageShow) {
      window.removeEventListener('pageshow', this.onPageShow);
    }
    this.$store.commit('setShowingServerJob', false);
  },
  methods: {
    async refreshReturning() {
      const api = this.$store.state.lfmApi as LastFm;
      try {
        // Only /scrobble's sign-in handler runs init(), so a visit that starts
        // here has to read the stored user itself.
        api.loadStoredUser();
        this.returning = await detectReturning(api, this.stateManager);
        const r = this.returning;
        this.$store.commit('setShowingServerJob', r.kind === 'server_job' && !this.dismissedReturning);
        if (r.kind !== 'none' && !this.dismissedReturning) {
          let state: string = r.kind;
          if (r.kind === 'saved') {
            state = r.signedIn ? 'saved_signed_in' : 'saved_signed_out';
          }
          trackEvent('home_returning_shown', { state });
        }
      } catch {
        this.returning = { kind: 'none' };
        this.$store.commit('setShowingServerJob', false);
      } finally {
        this.ready = true;
      }
    },
    async go(choice: HomeChoice) {
      if (this.lookingUp) {
        return;
      }
      trackEvent('home_choice', { choice });
      const api = this.$store.state.lfmApi as LastFm;
      // "Re-connect to last.fm" signs in first; /scrobble's job or resume
      // banner takes it from there.
      if (choice === 'resume' && !api.isAuthenticated()) {
        // With a worker, signing in to it says whether it holds an import for
        // this account, without the browser's own Last.fm sign-in.
        if (isBackgroundConfigured()) {
          this.lookingUp = true;
          setWorkerLookup(true);
          const url = await startReauth('');
          if (url) {
            trackEvent('worker_lookup_started');
            window.location.href = url;
            return;
          }
          setWorkerLookup(false);
          this.lookingUp = false;
        }
        startSignIn(api, { kind: 'reconnect' });
        return;
      }
      this.$router.push('/scrobble');
    },
    showGetExport() {
      trackEvent('home_choice', { choice: 'get_export' });
      this.gettingExport = true;
    },
    // Resumes the saved progress either way: not signed in as its owner, sign
    // in first; signed in, an in-app intent that /scrobble's sign-in handler
    // picks up on mount, so there's no second "Resume" click.
    continueSaved() {
      const r = this.returning;
      if (r.kind === 'saved' && !r.signedIn) {
        startSignIn(this.$store.state.lfmApi as LastFm, { kind: 'resume' });
        return;
      }
      setSignInIntent({ kind: 'resume' });
      this.openScrobble();
    },
    // /scrobble's resume banner, or its upload step, takes it from here.
    openScrobble() {
      this.$router.push('/scrobble');
    },
    /*
      Shows the first visit for the rest of this tab. Signs out only when the
      card welcomed the stored user: saved progress can belong to someone
      else, and signing out the stored user for it would log out the wrong
      person. Saved progress is deliberately kept: it may still be the
      user's, and it stays reachable from /scrobble's resume banner.
    */
    notYou() {
      const api = this.$store.state.lfmApi as LastFm;
      const r = this.returning;
      if (r.kind === 'username_only' || (r.kind === 'saved' && sameUser(r.username, api.getUserName()))) {
        api.clearUser();
        resetUser();
        trackEvent('user_logged_out');
      }
      writeDismissed();
      this.dismissedReturning = true;
      this.$store.commit('setShowingServerJob', false);
    },
  },
});
</script>
