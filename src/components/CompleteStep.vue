<template>
  <div>
    <h1>Done!</h1>
    We scrobbled {{ this.$store.state.tracksScrobbled }} tracks ({{ this.$store.state.tracksFailed }} failed).<br>
    If a significant number of scrobbles failed, please let me know at niko@savas.ca.
  </div>
</template>
<script lang="ts">
import Vue from 'vue';
export default Vue.extend({
});
</script>

