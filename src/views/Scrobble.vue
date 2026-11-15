<template>
  <div class="scrobble">
    <scrobblify></scrobblify>
  </div>
</template>
<script lang="ts">
import { defineComponent } from 'vue';
import ScrobblifyVue from '@/components/Scrobblify.vue';

export default defineComponent({
  components: {
    scrobblify: ScrobblifyVue,
  },
});
</script>
