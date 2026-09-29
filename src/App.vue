<template>
  <div id="app">
    <v-app>
      <div id="nav">
        <div id="logo">
          <img src="./assets/logo.png" alt=""> scrobblify
        </div>
        <router-link to="/">Home</router-link> |
        <router-link to="/scrobble">Scrobble</router-link> |
        <router-link to="/about">About</router-link>
      </div>
      <router-view/>
      <footer id="site-footer">
        <span :title="buildLabel">Scrobblify</span> &middot; built by
        <a href="https://savas.ca">Niko Savas</a>
      </footer>
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
import Vue from 'vue';
import { BUILD_NUMBER, GIT_SHA } from './buildInfo';

export default Vue.extend({
  computed: {
    buildLabel(): string {
      return `${GIT_SHA} · Build ${BUILD_NUMBER}`;
    },
  },
});
</script>
