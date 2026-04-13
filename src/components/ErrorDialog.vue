<template>
  <v-dialog v-model="visible" max-width="500" persistent>
    <v-card>
      <v-card-title class="error-dialog-title">
        <v-icon color="error" class="mr-2">mdi-alert-circle</v-icon>
        Something went wrong
      </v-card-title>
      <v-card-text class="pt-4">
        <p>{{ message }}</p>
        <p class="mt-3">
          If this keeps happening, please send an email to
          <a :href="mailtoLink">niko@savas.ca</a>
          with a description of what you were doing when this error occurred.
        </p>
        <v-expansion-panels v-if="details" flat class="mt-2">
          <v-expansion-panel>
            <v-expansion-panel-header class="pa-0 caption">
              Technical details
            </v-expansion-panel-header>
            <v-expansion-panel-content>
              <code class="error-details">{{ details }}</code>
            </v-expansion-panel-content>
          </v-expansion-panel>
        </v-expansion-panels>
      </v-card-text>
      <v-card-actions>
        <v-spacer></v-spacer>
        <v-btn color="primary" text @click="close">OK</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>
<style scoped>
.error-dialog-title {
  word-break: break-word;
}
.error-details {
  display: block;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  background: #f5f5f5;
  padding: 8px;
  border-radius: 4px;
}
</style>
<script lang="ts">
import Vue from 'vue';
export default Vue.extend({
  props: {
    value: { type: Boolean, default: false },
    message: { type: String, default: 'An unexpected error occurred.' },
    details: { type: String, default: '' },
  },
  computed: {
    visible: {
      get(): boolean { return this.value; },
      set(val: boolean) { this.$emit('input', val); },
    },
    mailtoLink(): string {
      const subject = encodeURIComponent('Scrobblify error report');
      const body = encodeURIComponent(
        `Hi Niko,\n\nI encountered an error while using Scrobblify.\n\nError: ${this.message}\n${this.details ? `Details: ${this.details}\n` : ''}\nWhat I was doing:\n\n`,
      );
      return `mailto:niko@savas.ca?subject=${subject}&body=${body}`;
    },
  },
  methods: {
    close() {
      this.visible = false;
    },
  },
});
</script>
