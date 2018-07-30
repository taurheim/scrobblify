<template>
  <div class="scrobble">
    <scrobblify></scrobblify>
  </div>
</template>
<script lang="ts">
import Vue from 'vue';
import ScrobblifyVue from '@/components/Scrobblify.vue';
export default Vue.extend({
  components: {
    scrobblify: ScrobblifyVue,
  },
});
</script>

