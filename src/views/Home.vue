<template>
  <div class="home">
    <Scrobblify></Scrobblify>
  </div>
</template>

<script lang="ts">
import { Component, Vue } from 'vue-property-decorator';
import Scrobblify from '@/components/Scrobblify.vue';

@Component({
  components: {
    Scrobblify,
  },
})
export default class Home extends Vue {}
</script>
