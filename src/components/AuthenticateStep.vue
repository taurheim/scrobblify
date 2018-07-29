<template>
  <div>
    <h1>Authorize the Scrobblify application with last.fm</h1>
    <a href="http://www.last.fm/api/auth/?api_key=2bf354b70b4a9a8a4420b2c48333d23e&cb=https://savas.ca/scrobblify/">Click here to authorize</a>
  </div>
</template>
<style>

</style>
<script lang="ts">
import Vue from 'vue';
export default Vue.extend({
  methods: {
    finishStep() {
      this.$emit('complete');
    },
  },
});
</script>
