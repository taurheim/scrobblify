<template>
  <div class="get-export">
    <a href="#" class="get-export-back" @click.prevent="$emit('back')">← Back</a>
    <h2>Get your history from Spotify</h2>
    <ol>
      <li>
        Go to
        <a
          href="https://www.spotify.com/account/privacy/"
          target="_blank"
          rel="noopener noreferrer"
        >your Spotify privacy settings</a>
        and request <strong>Extended streaming history</strong> (not "Account data").
      </li>
      <li>Wait for Spotify's email. Usually a few days.</li>
      <li>Download the ZIP and upload it in <router-link to="/scrobble">scrobble</router-link></li>
    </ol>
  </div>
</template>

<style>
.get-export {
  text-align: left;
  max-width: 520px;
  margin: 0 auto;
}

.get-export h2 {
  margin: 12px 0;
}

.get-export li {
  margin-bottom: 10px;
}
</style>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'HomeGetExport',
  emits: ['back'],
});
</script>
