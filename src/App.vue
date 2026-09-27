<template>
  <div id="app">
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
      <router-view/>
    </v-app>
  </div>
</template>

<style>
#app {
  font-family: 'Avenir', Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-align: center;
  color: #2c3e50;
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
</style>
<script lang="ts">
import Vue from 'vue';

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

export default Vue.extend({
  data() {
    return { mockMode: MOCK_MODE };
  },
});
</script>
