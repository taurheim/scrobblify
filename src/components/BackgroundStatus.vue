<template>
  <div class="background-status">
    <v-card class="status-card mx-auto" max-width="440">
      <v-card-title class="text-wrap">{{ title }}</v-card-title>
      <v-card-text>
        <div v-if="view.bar || inlinePrimary" class="status-bar-row">
          <v-progress-linear
            v-if="view.bar"
            class="status-bar"
            :model-value="view.bar.pct"
            color="primary"
            height="22"
            rounded
          >
            <span class="returning-bar-label">{{ barLabel }}</span>
          </v-progress-linear>
          <v-btn
            v-if="inlinePrimary && view.primary"
            class="status-action status-toggle"
            size="small"
            variant="outlined"
            :loading="busy"
            :disabled="busy || view.primaryDisabled"
            @click="act(view.primary)"
          >{{ label(view.primary) }}</v-btn>
        </div>
        <p class="status-line">
          <template v-for="(part, i) in view.lineParts" :key="i">
            <a v-if="part.href" :href="part.href" target="_blank" rel="noopener">{{ part.text }}</a>
            <button
              v-else-if="part.action"
              type="button"
              class="link-button"
              :disabled="busy"
              @click="act(part.action)"
            >{{ part.text }}</button>
            <template v-else>{{ part.text }}</template>
          </template>
          <template v-if="view.showRejected > 0">
            · {{ view.showRejected.toLocaleString() }} rejected by Last.fm
            (if this is unexpected please email niko@savas.ca)
          </template>
          <v-tooltip v-if="view.tooltip" :text="view.tooltip" location="top">
            <template #activator="{ props: tip }">
              <v-icon
                v-bind="tip"
                class="status-reason ml-1"
                size="small"
                tabindex="0"
                aria-label="Why?"
              >mdi-information-outline</v-icon>
            </template>
          </v-tooltip>
        </p>
        <p v-if="view.sub" class="status-sub">{{ view.sub }}</p>
        <p v-if="notice" class="status-notice text-error">{{ notice }}</p>
      </v-card-text>

      <v-card-actions v-if="blockPrimary || view.secondary.length" class="flex-column">
        <v-btn
          v-if="view.primary === 'checkItOut'"
          class="status-action"
          color="primary"
          variant="flat"
          block
          :href="lastFmUrl"
          target="_blank"
          rel="noopener"
        >{{ label('checkItOut') }}</v-btn>
        <v-btn
          v-else-if="blockPrimary && view.primary"
          class="status-action"
          color="primary"
          variant="flat"
          block
          :loading="busy"
          :disabled="busy || view.primaryDisabled"
          @click="act(view.primary)"
        >{{ label(view.primary) }}</v-btn>
        <div v-if="view.secondary.length" class="status-secondary">
          <v-btn
            v-for="action in view.secondary"
            :key="action"
            class="status-action"
            variant="text"
            size="small"
            :disabled="busy"
            @click="act(action)"
          >{{ label(action) }}</v-btn>
        </div>
      </v-card-actions>
    </v-card>

    <v-dialog v-model="confirmingCancel" max-width="440">
      <v-card class="status-cancel">
        <v-card-title class="text-wrap">Stop scrobbling</v-card-title>
        <v-card-text>
          Your remaining tracks will be deleted from our servers. The {{ doneLabel }} already
          scrobbled to last.fm will stay there.
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="confirmingCancel = false">Keep scrobbling</v-btn>
          <v-btn color="error" variant="flat" @click="confirmCancel">Cancel</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </div>
</template>

<style>
.status-bar-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.status-bar {
  flex: 1 1 auto;
}

.status-line {
  margin: 12px 0 0;
}

.status-sub {
  margin: 4px 0 0;
}

.status-notice {
  margin: 8px 0 0;
}

.status-secondary {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px;
  margin-top: 8px;
}
</style>

<script lang="ts">
import { defineComponent, PropType } from 'vue';
import { progressLabel } from '@/services/ReturningVisitor';
import { StatusAction, StatusView } from '@/services/JobStatus';

const LABELS: Record<StatusAction, string> = {
  pause: 'Pause',
  resume: 'Resume',
  reconnect: 'Reconnect',
  signInAgain: 'Sign in again',
  tryAgain: 'Try again',
  signIn: 'Sign in',
  moveBack: 'Scrobble the rest locally',
  cancel: 'Cancel',
  checkItOut: 'Check it out!',
  newImport: 'Start a new import',
};

type StatusEvent =
  | 'pause' | 'resume' | 'reconnect' | 'sign-in-again' | 'try-again' | 'sign-in' | 'move-back' | 'new-import';

// One event per action. `checkItOut` is a link and `cancel` asks first.
const EVENTS: Partial<Record<StatusAction, StatusEvent>> = {
  pause: 'pause',
  resume: 'resume',
  reconnect: 'reconnect',
  signInAgain: 'sign-in-again',
  tryAgain: 'try-again',
  signIn: 'sign-in',
  moveBack: 'move-back',
  newImport: 'new-import',
};

export default defineComponent({
  name: 'BackgroundStatus',
  props: {
    view: { type: Object as PropType<StatusView>, required: true },
    username: { type: String as PropType<string | null>, default: null },
    busy: { type: Boolean, default: false },
    /** Shown under the line, e.g. when the server couldn't be reached. */
    notice: { type: String, default: '' },
  },
  emits: [
    'pause', 'resume', 'reconnect', 'sign-in-again', 'try-again', 'sign-in', 'move-back', 'cancel', 'new-import',
  ],
  data() {
    return { confirmingCancel: false };
  },
  computed: {
    title(): string {
      return this.username ? `Scrobbling to ${this.username}` : 'Scrobbling to Last.fm';
    },
    barLabel(): string {
      return this.view.bar ? progressLabel(this.view.bar.done, this.view.bar.total) : '';
    },
    // Pause and Resume sit beside the bar; everything else goes under the line.
    inlinePrimary(): boolean {
      return this.view.primary === 'pause' || this.view.primary === 'resume';
    },
    blockPrimary(): boolean {
      return !!this.view.primary && !this.inlinePrimary;
    },
    doneLabel(): string {
      return (this.view.bar ? this.view.bar.done : 0).toLocaleString();
    },
    lastFmUrl(): string {
      return `https://www.last.fm/user/${encodeURIComponent(this.username || '')}`;
    },
  },
  methods: {
    label(action: StatusAction): string {
      return LABELS[action];
    },
    act(action: StatusAction) {
      if (action === 'cancel') {
        this.confirmingCancel = true;
        return;
      }
      const event = EVENTS[action];
      if (event) {
        this.$emit(event);
      }
    },
    confirmCancel() {
      this.confirmingCancel = false;
      this.$emit('cancel');
    },
  },
});
</script>
