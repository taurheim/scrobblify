<template>
  <v-dialog :model-value="modelValue" max-width="440" @update:model-value="onToggle">
    <v-card class="move-back-explainer">
      <v-card-title class="text-wrap">Scrobble the rest locally?</v-card-title>
      <v-card-text>
        Scrobblify talks to Last.fm in two ways, one for its server and one for your browser, so
        Last.fm will ask you to approve Scrobblify again. You won't lose your progress.
      </v-card-text>
      <v-card-actions>
        <v-spacer />
        <v-btn variant="text" @click="choose('cancel')">Cancel</v-btn>
        <v-btn color="primary" variant="flat" @click="choose('continue')">Continue to Last.fm</v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

/*
  Shown by "Scrobble the rest locally" when this browser has no Last.fm
  session of its own: the server's sign-in doesn't let the browser scrobble,
  so Last.fm asks a second time. Closing it any other way counts as Cancel.
*/
export default defineComponent({
  name: 'MoveBackExplainer',
  props: {
    modelValue: { type: Boolean, default: false },
  },
  emits: ['update:modelValue', 'continue', 'cancel'],
  methods: {
    choose(choice: 'continue' | 'cancel') {
      this.$emit('update:modelValue', false);
      this.$emit(choice);
    },
    onToggle(open: boolean) {
      if (!open && this.modelValue) {
        this.choose('cancel');
      }
    },
  },
});
</script>
