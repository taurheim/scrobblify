import type { Router } from 'vue-router';
import { trackEvent } from './Analytics';
import store from '../store';

/*
  Reloads once when a lazy route's chunk can't be loaded.

  The FTP deploy deletes the previous build's chunks, so a tab (or a cached
  index.html) from an older build that navigates to a lazy route asks for a file
  that no longer exists. Without this the navigation just fails: the link does
  nothing. A full load of the target URL fetches the current index.html, which
  names chunks that do exist.

  Once per RELOAD_COOLDOWN_MS per tab, so a chunk that is missing from the
  current build too can't reload-loop, and never while a run is scrobbling,
  because a reload then drops everything since the last checkpoint.
*/

const RELOAD_KEY = 'scrobblify.chunkReloadAt';
const RELOAD_COOLDOWN_MS = 60 * 1000;

export function isChunkLoadError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown };
  return name === 'ChunkLoadError'
    || code === 'CSS_CHUNK_LOAD_FAILED'
    || (typeof message === 'string' && /Loading (CSS )?chunk \S+ failed/.test(message));
}

// 'no_storage' when sessionStorage is unusable: without it a loop can't be ruled out.
function claimReload(): 'ok' | 'recent_reload' | 'no_storage' {
  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY));
    if (last && Date.now() - last < RELOAD_COOLDOWN_MS) {
      return 'recent_reload';
    }
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return 'ok';
  } catch (e) {
    return 'no_storage';
  }
}

export function installChunkReload(router: Router): void {
  router.onError((error, to) => {
    if (!isChunkLoadError(error)) {
      // A handler replaces vue-router's own logging of navigation errors.
      if (process.env.NODE_ENV !== 'production') {
        // eslint-disable-next-line no-console
        console.error(error);
      }
      return;
    }
    const outcome = store.state.scrobbleRunActive ? 'run_active' : claimReload();
    const message = String((error as Error).message || '').split('\n')[0];
    trackEvent('chunk_load_failed', {
      reloaded: outcome === 'ok',
      skip_reason: outcome === 'ok' ? null : outcome,
      path: to.path,
      message,
    });
    if (outcome === 'ok') {
      window.location.assign(router.resolve(to).href);
    }
  });
}
