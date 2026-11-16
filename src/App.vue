<template>
  <v-app>
    <div v-if="mockMode" id="mock-banner">
      <strong>MOCK MODE</strong> — Last.fm is faked. Nothing is really scrobbled.
    </div>
    <div id="nav">
      <div id="logo">
        <img src="./assets/logo.png" alt=""> scrobblify
      </div>
      <router-link to="/">Home</router-link> |
      <router-link to="/scrobble">Scrobble</router-link> |
      <router-link to="/about">About</router-link>
    </div>
    <v-alert
      v-if="showUpdateBanner"
      id="update-available"
      type="info"
      variant="tonal"
      density="compact"
      class="mx-auto mb-4"
      max-width="720"
    >
      <div class="d-flex align-center flex-wrap">
        <span class="mr-4">
          A newer version of Scrobblify is available. Reload to get the latest
          fixes &mdash; your saved progress is kept.
        </span>
        <v-btn size="small" color="primary" @click="reloadForUpdate">Reload</v-btn>
      </div>
    </v-alert>
    <router-view/>
    <footer id="site-footer">
      <span :title="buildLabel" :data-build-check="buildCheck">Scrobblify</span> &middot; built by
      <a href="https://savas.ca">Niko Savas</a>
    </footer>
  </v-app>
</template>

<style>
/*
  App-wide defaults sit in the `app-base` layer, which public/index.html orders
  below Vuetify's utilities. Vuetify 4's utilities (`mb-0`, `pl-4`, …) are
  layered and no longer `!important`, so unlayered rules here would beat them.
*/
@layer app-base {
  /*
    Targets the v-app element itself, as `#app` did under Vuetify 2 (whose v-app
    carried id="app"). Dialogs are included because Vuetify renders them in
    `.v-overlay-container`, outside the app, where under Vuetify 2 they sat
    inside it and inherited all of this.
  */
  #app > .v-application,
  .v-overlay-container {
    font-family: 'Avenir', Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    text-align: center;
    color: #2c3e50;
  }

  /* Vuetify 2 gave every page these defaults; Vuetify 3 and 4 leave links unstyled. */
  .v-application a,
  .v-overlay-container a {
    color: rgb(var(--v-theme-primary));
  }

  .v-application p,
  .v-overlay-container p {
    margin-bottom: 16px;
  }

  .v-application ul,
  .v-application ol,
  .v-overlay-container ul,
  .v-overlay-container ol {
    padding-left: 24px;
  }
}

/* Vuetify 4 dropped the global reset that every page here was laid out against. */
@layer vuetify-core.reset {
  * {
    padding: 0;
    margin: 0;
  }
}

#nav {
  padding: 30px;
}

#logo {
  font-size: 36px;
  font-weight: bold;
}

#nav a {
  font-weight: bold;
}

/* Sticky rather than fixed: the point is to be impossible to miss, but not to
   sit on top of the app's own content. Hazard stripes because the failure this
   guards against is believing a real account is safe. */
#mock-banner {
  position: sticky;
  top: 0;
  z-index: 1000;
  padding: 10px 16px;
  font-size: 15px;
  color: #000;
  background: repeating-linear-gradient(
    45deg,
    #ffd54f,
    #ffd54f 12px,
    #ffb300 12px,
    #ffb300 24px
  );
  border-bottom: 2px solid #000;
}

#site-footer {
  margin-top: 40px;
  padding-bottom: 16px;
  font-size: 12px;
  letter-spacing: 0.05em;
  color: rgba(44, 62, 80, 0.4);
}

#site-footer a {
  color: inherit;
}
</style>
<script lang="ts">
import { defineComponent } from 'vue';
import { BUILD_NUMBER, GIT_SHA } from './buildInfo';
import { DeployedBuild, fetchDeployedBuild, isStaleBuild } from './services/BuildCheck';
import { trackEvent } from './services/Analytics';

const RECHECK_INTERVAL_MS = 30 * 60 * 1000;
// Returning to a backgrounded tab rechecks, but not on every quick switch.
const MIN_RECHECK_GAP_MS = 5 * 60 * 1000;
// Remembers which deployed build a reload was meant to pick up, so a reload
// that came back stale anyway (an intermediary still caching index.html) is
// distinguishable in analytics from a user who never reloaded.
const RELOADED_FOR_KEY = 'scrobblify_reloaded_for_build';

// Keyed off the API base rather than a dedicated flag, so there is no way to be
// mocked without being told. VUE_APP_* is inlined at build time and is
// `undefined` in production, which compiles the banner out entirely.
const MOCK_MODE = !!process.env.VUE_APP_LASTFM_API_BASE;

if (MOCK_MODE) {
  // eslint-disable-next-line no-console
  console.warn(
    '[scrobblify] MOCK MODE: Last.fm is served by the dev server, not the real API. '
    + 'Nothing you do here reaches a real account.',
  );
}

export default defineComponent({
  data() {
    return {
      mockMode: MOCK_MODE,
      // pending | current | stale | unknown (no readable version.json)
      buildCheck: 'pending',
      deployedBuild: null as DeployedBuild | null,
      checkingBuild: false,
      lastBuildCheckAt: 0,
      buildCheckTimer: null as number | null,
    };
  },
  computed: {
    buildLabel(): string {
      return `${GIT_SHA} · Build ${BUILD_NUMBER}`;
    },
    showUpdateBanner(): boolean {
      return this.buildCheck === 'stale' && !this.$store.state.scrobbleRunActive;
    },
  },
  mounted() {
    this.checkBuild();
    this.buildCheckTimer = window.setInterval(this.checkBuild, RECHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  },
  beforeUnmount() {
    if (this.buildCheckTimer !== null) {
      window.clearInterval(this.buildCheckTimer);
    }
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
  },
  methods: {
    onVisibilityChange() {
      if (document.visibilityState === 'visible'
        && Date.now() - this.lastBuildCheckAt >= MIN_RECHECK_GAP_MS) {
        this.checkBuild();
      }
    },
    async checkBuild() {
      if (this.buildCheck === 'stale' || this.checkingBuild) {
        return;
      }
      this.checkingBuild = true;
      this.lastBuildCheckAt = Date.now();
      try {
        const deployed = await fetchDeployedBuild();
        if (!deployed) {
          if (this.buildCheck === 'pending') {
            this.buildCheck = 'unknown';
          }
          return;
        }
        this.deployedBuild = deployed;
        if (!isStaleBuild(deployed)) {
          this.buildCheck = 'current';
          return;
        }
        this.buildCheck = 'stale';
        let reloadedForLatest = false;
        try {
          reloadedForLatest = window.sessionStorage.getItem(RELOADED_FOR_KEY) === deployed.sha;
        } catch (e) {
          // sessionStorage can be unavailable (privacy modes); not essential.
        }
        trackEvent('stale_build_detected', {
          latest_sha: deployed.sha,
          latest_run: deployed.run,
          reloaded_for_latest: reloadedForLatest,
        });
      } finally {
        this.checkingBuild = false;
      }
    },
    reloadForUpdate() {
      const latestSha = this.deployedBuild ? this.deployedBuild.sha : null;
      try {
        if (latestSha) {
          window.sessionStorage.setItem(RELOADED_FOR_KEY, latestSha);
        }
      } catch (e) {
        // ignore
      }
      trackEvent('stale_build_reload_clicked', { latest_sha: latestSha });
      window.location.reload();
    },
  },
});
</script>
