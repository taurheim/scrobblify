<template>
  <v-card class="returning-card mx-auto" max-width="440">
    <v-card-title class="text-wrap">{{ title }}</v-card-title>
    <v-card-text v-if="hasProgress || state.kind === 'server_job'">
      <v-progress-linear
        v-if="hasProgress"
        class="returning-bar"
        :model-value="pct"
        color="primary"
        height="22"
        rounded
      >
        <span class="returning-bar-label">{{ barLabel }}</span>
      </v-progress-linear>
      <p v-if="state.kind === 'server_job'" class="mt-3 mb-0">Scrobbling remotely, it's safe to close this tab.</p>
    </v-card-text>

    <v-card-actions v-if="state.kind === 'saved'" class="flex-column">
      <v-btn color="primary" variant="flat" block @click="$emit('continue')">Continue</v-btn>
      <div class="returning-links mt-2">
        <button type="button" class="link-button" @click="$emit('not-you')">Not you?</button>
        <span aria-hidden="true"> · </span>
        <button type="button" class="link-button" @click="$emit('start-over')">Start over</button>
      </div>
    </v-card-actions>

    <v-card-actions v-else-if="state.kind === 'username_only'" class="flex-column">
      <v-btn color="primary" variant="flat" block @click="$emit('upload')">Upload Spotify zip</v-btn>
      <div class="returning-links mt-2">
        <button type="button" class="link-button" @click="$emit('not-you')">Not you?</button>
        <span aria-hidden="true"> · </span>
        <button type="button" class="link-button" @click="$emit('show-get-export')">Show me how</button>
      </div>
    </v-card-actions>
  </v-card>
</template>

<style>
.returning-bar-label {
  font-size: 12px;
  font-weight: 700;
}

.returning-links {
  font-size: 13px;
}
</style>

<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { progressLabel, progressPct, ReturningState } from '@/services/ReturningVisitor';

export default defineComponent({
  name: 'HomeReturning',
  props: {
    state: { type: Object as PropType<ReturningState>, required: true },
  },
  emits: ['continue', 'not-you', 'start-over', 'upload', 'show-get-export'],
  computed: {
    title(): string {
      const s = this.state;
      const name = s.kind === 'none' ? null : s.username;
      return name ? `Scrobbling to ${name}` : 'Welcome back';
    },
    hasProgress(): boolean {
      return (this.state.kind === 'saved' || this.state.kind === 'server_job') && this.state.total > 0;
    },
    pct(): number {
      const s = this.state;
      return s.kind === 'saved' || s.kind === 'server_job' ? progressPct(s.done, s.total) : 0;
    },
    barLabel(): string {
      const s = this.state;
      return s.kind === 'saved' || s.kind === 'server_job' ? progressLabel(s.done, s.total) : '';
    },
  },
});
</script>
