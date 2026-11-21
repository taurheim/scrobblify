<template>
  <div class="home">
    <h1 class="home-title">Retroactively scrobble Spotify plays to last.fm</h1>

    <home-get-export v-if="gettingExport" @back="gettingExport = false" />

    <div v-else-if="!ready" class="home-loading-wrap">
      <v-progress-circular indeterminate color="primary" class="home-loading" />
    </div>

    <template v-else-if="returning.kind === 'none'">
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
import StateManager from '@/services/StateManager';
import { detectReturning, ReturningState } from '@/services/ReturningVisitor';
import { trackEvent } from '@/services/Analytics';

type HomeChoice = 'have_export' | 'get_export' | 'resume';

export default defineComponent({
  components: { 'home-get-export': HomeGetExport },
  data() {
    return {
      // Nothing renders until the returning check settles, so a returning
      // visitor never sees the first-visit page flash first.
      ready: false,
      gettingExport: false,
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
        this.returning = await detectReturning(api, this.stateManager);
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
  },
});
</script>
