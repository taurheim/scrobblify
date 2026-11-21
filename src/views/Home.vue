<template>
  <div class="home">
    <h1 class="home-title">Retroactively scrobble Spotify plays to last.fm</h1>

    <home-get-export v-if="gettingExport" @back="gettingExport = false" />

    <div v-else-if="!ready" class="home-loading-wrap">
      <v-progress-circular indeterminate color="primary" class="home-loading" />
    </div>

    <home-returning
      v-else-if="returning.kind !== 'none' && !dismissedReturning"
      :state="returning"
      @continue="openScrobble"
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
        <a href="#" @click.prevent="go('resume')">Re-connect to last.fm</a>
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
import { detectReturning, ReturningState } from '@/services/ReturningVisitor';
import { resetUser, trackEvent } from '@/services/Analytics';

type HomeChoice = 'have_export' | 'get_export' | 'resume';

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
    };
  },
  async mounted() {
    await this.refreshReturning();
  },
  methods: {
    async refreshReturning() {
      const api = this.$store.state.lfmApi as LastFm;
      try {
        // Only /scrobble's sign-in step runs init(), so a visit that starts
        // here has to read the stored user itself.
        api.loadStoredUser();
        this.returning = await detectReturning(api, this.stateManager);
        const r = this.returning;
        if (r.kind !== 'none') {
          let state: string = r.kind;
          if (r.kind === 'saved') {
            state = r.signedIn ? 'saved_signed_in' : 'saved_signed_out';
          }
          trackEvent('home_returning_shown', { state });
        }
      } catch {
        this.returning = { kind: 'none' };
      } finally {
        this.ready = true;
      }
    },
    go(choice: HomeChoice) {
      trackEvent('home_choice', { choice });
      this.$router.push('/scrobble');
    },
    showGetExport() {
      trackEvent('home_choice', { choice: 'get_export' });
      this.gettingExport = true;
    },
    // Until sign-in moves after choosing (Plan 3), /scrobble's own sign-in
    // step and resume banner take it from here.
    openScrobble() {
      this.$router.push('/scrobble');
    },
    /*
      Signs out and shows the first visit for the rest of this visit. Saved
      progress is deliberately kept: it may still be the user's, and it stays
      reachable from /scrobble's resume banner.
    */
    notYou() {
      (this.$store.state.lfmApi as LastFm).clearUser();
      resetUser();
      trackEvent('user_logged_out');
      this.dismissedReturning = true;
    },
  },
});
</script>
