<template>
  <div id="app">
    <v-app>
      <div id="nav">
        <div id="logo">
          <img src="./assets/logo.png"> scrobblify
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
</style>
<script lang="ts">
import Vue from 'vue';
export default Vue.extend({
});
</script>

