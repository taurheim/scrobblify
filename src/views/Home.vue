<template>
  <div class="home">
    <img src="../assets/logo.png">
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
