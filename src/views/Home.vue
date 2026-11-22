<template>
  <div class="home">
    <h1 class="home-title">Retroactively scrobble Spotify plays to last.fm</h1>

    <home-get-export v-if="gettingExport" @back="gettingExport = false" />

    <div v-else-if="!ready" class="home-loading-wrap">
      <v-progress-circular indeterminate color="primary" class="home-loading" aria-label="Loading" />
    </div>

    <background-status
      v-else-if="statusView"
      :view="statusView"
      :username="statusUsername"
      :busy="statusBusy"
      :notice="statusNotice"
      @pause="jobAct('pause')"
      @resume="jobAct('resume')"
      @try-again="jobAct('resume')"
      @reconnect="signInToWorker"
      @sign-in-again="signInToWorker"
      @sign-in="signInToWorker"
      @cancel="cancelJob"
      @new-import="newImport"
      @move-back="moveBack"
    />

    <home-returning
      v-else-if="returning.kind !== 'none' && !dismissedReturning"
      :state="returning"
      @continue="continueSaved"
      @start-over="openScrobble"
      @upload="openScrobble"
      @not-you="notYou"
      @show-get-export="showGetExport"
    />

    <template v-else>
      <div class="home-cards">
        <v-card class="home-card">
          <v-card-title class="text-wrap">Already got your streaming history zip?</v-card-title>
          <v-card-actions>
            <v-btn color="primary" variant="flat" block @click="go('have_export')">Start</v-btn>
          </v-card-actions>
        </v-card>
        <v-card class="home-card">
          <v-card-title class="text-wrap">Don't have it yet?</v-card-title>
          <v-card-actions>
            <v-btn color="primary" variant="flat" block @click="showGetExport">Show me how</v-btn>
          </v-card-actions>
        </v-card>
      </div>
      <p class="home-already">
        Already scrobbling on scrobblify?
        <button type="button" class="link-button" :disabled="lookingUp" @click="go('resume')">
          Re-connect to last.fm
        </button>
      </p>
    </template>

    <move-back-explainer v-model="explainingMoveBack" @continue="continueMoveBack" @cancel="cancelMoveBack" />
  </div>
</template>

<style>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: 0 5%;
}

.home-title {
  margin: 8px 0 24px;
}

.home-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

@media (max-width: 600px) {
  .home-cards {
    grid-template-columns: 1fr;
  }
}

.home-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.home-already {
  margin-top: 24px;
}

.home-loading-wrap {
  display: flex;
  justify-content: center;
}
</style>

<script lang="ts">
import { defineComponent, markRaw } from 'vue';
import LastFm from '@/api/LastFm';
import BackgroundStatus from '@/components/BackgroundStatus.vue';
import MoveBackExplainer from '@/components/MoveBackExplainer.vue';
import HomeGetExport from '@/components/home/HomeGetExport.vue';
import HomeReturning from '@/components/home/HomeReturning.vue';
import StateManager from '@/services/StateManager';
import {
  detectReturning, HOME_DISMISSED_KEY, ReturningState, sameUser,
} from '@/services/ReturningVisitor';
import { resetUser, trackEvent } from '@/services/Analytics';
import { setSignInIntent, startSignIn } from '@/services/SignInIntent';
import {
  clearHandedOverImport, dismissJob, fetchJob, getSession, isBackgroundConfigured, jobAction,
  setWorkerLookup, startReauth,
} from '@/services/BackgroundScrobbling';
import {
  isJobShown, JOB_CLOCK_TICK_MS, JOB_POLL_FALLBACK_SECONDS, jobPollDueSec, StatusView,
  viewFromImport, viewFromJob, viewOtherDevice,
} from '@/services/JobStatus';

type HomeChoice = 'have_export' | 'get_export' | 'resume';

const SERVER_UNREACHABLE = 'Couldn\'t reach our server. Try again in a few minutes.';

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function readDismissed(): boolean {
  try {
    return sessionStorage.getItem(HOME_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function writeDismissed() {
  try {
    sessionStorage.setItem(HOME_DISMISSED_KEY, '1');
  } catch {
    // Private modes can refuse storage; the in-component flag still holds.
  }
}

export default defineComponent({
  components: {
    'background-status': BackgroundStatus,
    'move-back-explainer': MoveBackExplainer,
    'home-get-export': HomeGetExport,
    'home-returning': HomeReturning,
  },
  data() {
    return {
      // Nothing renders until the returning check settles, so a returning
      // visitor never sees the first-visit page flash first.
      ready: false,
      gettingExport: false,
      dismissedReturning: false,
      returning: { kind: 'none' } as ReturningState,
      stateManager: markRaw(new StateManager()),
      /** "Re-connect" is asking the worker for its sign-in link. */
      lookingUp: false,
      onPageShow: null as ((event: PageTransitionEvent) => void) | null,
      /** A status page action is under way. */
      statusBusy: false,
      statusNotice: '',
      /** Bumped by every action, so a poll that lands after one is discarded. */
      statusSeq: 0,
      nowSec: nowSec(),
      jobPollDueSec: 0,
      jobPolling: false,
      jobClockTimer: null as number | null,
      onVisibilityChange: null as (() => void) | null,
      /** "Scrobble the rest locally" is explaining the second Last.fm approval. */
      explainingMoveBack: false,
    };
  },
  computed: {
    statusView(): StatusView | null {
      const r = this.returning;
      if (r.kind !== 'job') {
        return null;
      }
      if (r.source === 'job') {
        return viewFromJob(r.job, { nowSec: this.nowSec, originalTotal: r.originalTotal });
      }
      if (r.source === 'import') {
        return viewFromImport(r.status, { nowSec: this.nowSec, originalTotal: r.originalTotal });
      }
      return viewOtherDevice();
    },
    statusUsername(): string | null {
      return this.returning.kind === 'job' ? this.returning.username : null;
    },
  },
  watch: {
    // Every new answer about the job decides when to ask again.
    returning() {
      this.scheduleJobPoll();
    },
  },
  async mounted() {
    // A lookup only ever starts here, so one still flagged is from a trip to
    // Last.fm the user came back from without finishing.
    setWorkerLookup(false);
    // Pressing Back on Last.fm can restore this page as it was left.
    this.onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        this.lookingUp = false;
        this.statusBusy = false;
        setWorkerLookup(false);
      }
    };
    window.addEventListener('pageshow', this.onPageShow);
    this.dismissedReturning = readDismissed();
    await this.refreshReturning();
  },
  beforeUnmount() {
    if (this.onPageShow) {
      window.removeEventListener('pageshow', this.onPageShow);
    }
    this.stopJobClock();
    this.$store.commit('setShowingServerJob', false);
  },
  methods: {
    async refreshReturning() {
      const api = this.$store.state.lfmApi as LastFm;
      try {
        // Only /scrobble's sign-in handler runs init(), so a visit that starts
        // here has to read the stored user itself.
        api.loadStoredUser();
        this.returning = await detectReturning(api, this.stateManager);
        const r = this.returning;
        // The status page shows whatever "Not you?" said: it is about a job.
        this.$store.commit('setShowingServerJob', r.kind === 'job');
        if (r.kind === 'job') {
          trackEvent('home_returning_shown', {
            state: 'server_job',
            source: r.source,
            ...(r.source === 'job' ? { job_state: r.job.state } : {}),
          });
        } else if (r.kind !== 'none' && !this.dismissedReturning) {
          let state: string = r.kind;
          if (r.kind === 'saved') {
            state = r.signedIn ? 'saved_signed_in' : 'saved_signed_out';
          }
          trackEvent('home_returning_shown', { state });
        }
      } catch {
        this.returning = { kind: 'none' };
        this.$store.commit('setShowingServerJob', false);
      } finally {
        this.ready = true;
      }
    },

    /*
      The status page refreshes itself (see `jobPollDueSec`): an active job
      just after each of its batches, and a job on hold for a full server every
      few minutes, so Reconnect comes back when a place opens up. Only while
      the tab is visible; a tab shown again asks at once.
    */
    scheduleJobPoll() {
      this.nowSec = nowSec();
      const r = this.returning;
      const due = r.kind === 'job' && r.source === 'job' ? jobPollDueSec(r.job, this.nowSec) : null;
      if (due === null) {
        this.stopJobClock();
        return;
      }
      this.jobPollDueSec = due;
      this.startJobClock();
    },

    startJobClock() {
      if (this.jobClockTimer !== null) { return; }
      this.jobClockTimer = window.setInterval(() => this.onJobClockTick(false), JOB_CLOCK_TICK_MS);
      this.onVisibilityChange = () => {
        if (document.visibilityState === 'visible') {
          this.onJobClockTick(true);
        }
      };
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    },

    stopJobClock() {
      if (this.jobClockTimer !== null) {
        window.clearInterval(this.jobClockTimer);
        this.jobClockTimer = null;
      }
      if (this.onVisibilityChange) {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.onVisibilityChange = null;
      }
    },

    onJobClockTick(returning: boolean) {
      this.nowSec = nowSec();
      if (document.visibilityState !== 'visible') { return; }
      if (returning || this.nowSec >= this.jobPollDueSec) {
        this.pollJob();
      }
    },

    /**
     * Refreshes the status page without letting a slow or failed answer undo
     * anything newer. A failed check keeps the page as it was; a job that is
     * gone (cancelled elsewhere) or a session the worker refused sends Home
     * back through the whole decision.
     */
    async pollJob() {
      const r = this.returning;
      if (r.kind !== 'job' || r.source !== 'job' || this.jobPolling || this.statusBusy) { return; }
      const seq = this.statusSeq;
      this.jobPolling = true;
      const job = await fetchJob();
      this.jobPolling = false;
      if (seq !== this.statusSeq || this.statusBusy || this.returning !== r) { return; }
      if (isJobShown(job)) {
        this.returning = { ...r, job };
        return;
      }
      if (job || !getSession()) {
        await this.refreshReturning();
        return;
      }
      this.jobPollDueSec = nowSec() + JOB_POLL_FALLBACK_SECONDS;
    },

    /** Pause, Resume, and Try again (a resume of a job stopped by errors). */
    async jobAct(action: 'pause' | 'resume') {
      const r = this.returning;
      if (r.kind !== 'job' || r.source !== 'job' || this.statusBusy) { return; }
      this.statusSeq += 1;
      this.statusBusy = true;
      this.statusNotice = '';
      if (!await jobAction(r.job.id, action)) {
        this.statusNotice = SERVER_UNREACHABLE;
      }
      const job = await fetchJob();
      this.statusBusy = false;
      if (isJobShown(job)) {
        this.returning = { ...r, job };
      } else if (job || !getSession()) {
        await this.refreshReturning();
      }
    },

    /*
      Reconnect, Sign in again and Sign in all sign in to the worker: it
      re-attaches a job's Last.fm access, or just gives this browser a session
      to manage the job with. The return lands on /scrobble.
    */
    async signInToWorker() {
      if (this.statusBusy) { return; }
      this.statusBusy = true;
      this.statusNotice = '';
      trackEvent('background_reauth_started', { source: 'home' });
      const url = await startReauth(this.statusUsername || '');
      if (!url) {
        this.statusBusy = false;
        this.statusNotice = SERVER_UNREACHABLE;
        return;
      }
      window.location.href = url;
    },

    async cancelJob() {
      const r = this.returning;
      if (r.kind !== 'job' || r.source !== 'job' || this.statusBusy) { return; }
      this.statusSeq += 1;
      this.statusBusy = true;
      this.statusNotice = '';
      if (!await jobAction(r.job.id, 'cancel')) {
        this.statusBusy = false;
        this.statusNotice = SERVER_UNREACHABLE;
        return;
      }
      clearHandedOverImport();
      await this.refreshReturning();
      this.statusBusy = false;
    },

    // A finished job stays out of the way from now on.
    newImport() {
      const r = this.returning;
      if (r.kind === 'job' && r.source === 'job') {
        dismissJob(r.job.id);
      }
      this.$router.push('/scrobble');
    },

    /*
      "Scrobble the rest locally": /scrobble takes the job's progress back
      (`takeBack` intent) and sends from this browser. That needs this
      browser's own Last.fm session, so without one Last.fm is asked first,
      after a word on why it asks again.
    */
    moveBack() {
      const r = this.returning;
      if (r.kind !== 'job' || r.source !== 'job' || this.statusBusy) { return; }
      if ((this.$store.state.lfmApi as LastFm).isAuthenticated()) {
        setSignInIntent({ kind: 'takeBack', jobId: r.job.id });
        this.$router.push('/scrobble');
        return;
      }
      this.explainingMoveBack = true;
      trackEvent('move_back_explainer_shown');
    },
    continueMoveBack() {
      const r = this.returning;
      trackEvent('move_back_explainer_choice', { choice: 'continue' });
      if (r.kind !== 'job' || r.source !== 'job') { return; }
      startSignIn(this.$store.state.lfmApi as LastFm, { kind: 'takeBack', jobId: r.job.id });
    },
    cancelMoveBack() {
      trackEvent('move_back_explainer_choice', { choice: 'cancel' });
    },
    async go(choice: HomeChoice) {
      if (this.lookingUp) {
        return;
      }
      trackEvent('home_choice', { choice });
      const api = this.$store.state.lfmApi as LastFm;
      // "Re-connect to last.fm" signs in first; /scrobble's job or resume
      // banner takes it from there.
      if (choice === 'resume' && !api.isAuthenticated()) {
        // With a worker, signing in to it says whether it holds an import for
        // this account, without the browser's own Last.fm sign-in.
        if (isBackgroundConfigured()) {
          this.lookingUp = true;
          setWorkerLookup(true);
          const url = await startReauth('');
          if (url) {
            trackEvent('worker_lookup_started');
            window.location.href = url;
            return;
          }
          setWorkerLookup(false);
          this.lookingUp = false;
        }
        startSignIn(api, { kind: 'reconnect' });
        return;
      }
      this.$router.push('/scrobble');
    },
    showGetExport() {
      trackEvent('home_choice', { choice: 'get_export' });
      this.gettingExport = true;
    },
    // Resumes the saved progress either way: not signed in as its owner, sign
    // in first; signed in, an in-app intent that /scrobble's sign-in handler
    // picks up on mount, so there's no second "Resume" click.
    continueSaved() {
      const r = this.returning;
      if (r.kind === 'saved' && !r.signedIn) {
        startSignIn(this.$store.state.lfmApi as LastFm, { kind: 'resume' });
        return;
      }
      setSignInIntent({ kind: 'resume' });
      this.openScrobble();
    },
    // /scrobble's resume banner, or its upload step, takes it from here.
    openScrobble() {
      this.$router.push('/scrobble');
    },
    /*
      Shows the first visit for the rest of this tab. Signs out only when the
      card welcomed the stored user: saved progress can belong to someone
      else, and signing out the stored user for it would log out the wrong
      person. Saved progress is deliberately kept: it may still be the
      user's, and it stays reachable from /scrobble's resume banner.
    */
    notYou() {
      const api = this.$store.state.lfmApi as LastFm;
      const r = this.returning;
      if (r.kind === 'username_only' || (r.kind === 'saved' && sameUser(r.username, api.getUserName()))) {
        api.clearUser();
        resetUser();
        trackEvent('user_logged_out');
      }
      writeDismissed();
      this.dismissedReturning = true;
      this.$store.commit('setShowingServerJob', false);
    },
  },
});
</script>
