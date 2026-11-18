import { BUILD_NUMBER, GIT_SHA } from '../buildInfo';

/*
  Detects a tab running an older build than the one deployed.

  Browsers keep serving an old index.html (heuristic caching, restored or
  discarded tabs), and with its chunks in the browser's cache a stale page
  still boots fine and runs code missing every fix since. In
  telemetry this showed up as users on builds days to months old, still hitting
  bugs that had been fixed for them.

  CI writes version.json next to index.html on every build (see ci.yml), so the
  deployed build is one no-store fetch away. A missing or malformed file, as on
  a local dev server, means "unknown", never "stale".

  Some browsers still hand back a version.json they fetched days earlier,
  despite no-store (#138), and a sha comparison alone then tells a tab on the
  current build that an *older* one is newer. So each fetch gets a unique URL,
  and an answer with a lower CI run number than this build's is ignored.
*/

export interface DeployedBuild {
  sha: string;
  run: number | null;
}

const VERSION_URL = `${process.env.BASE_URL || '/'}version.json`;

export async function fetchDeployedBuild(): Promise<DeployedBuild | null> {
  try {
    const response = await fetch(`${VERSION_URL}?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    if (!body || typeof body.sha !== 'string' || !/^[0-9a-f]{7}$/.test(body.sha)) {
      return null;
    }
    return { sha: body.sha, run: Number.isInteger(body.run) && body.run > 0 ? body.run : null };
  } catch (e) {
    return null;
  }
}

const RUNNING_RUN = /^\d+$/.test(BUILD_NUMBER) ? Number(BUILD_NUMBER) : null;

export type BuildComparison = 'current' | 'newer' | 'older';

// A sha that differs is "newer" unless both run numbers are known and the
// deployed one isn't higher. Local builds (BUILD_NUMBER `local`) and files
// without a run fall back to the sha alone.
export function compareDeployedBuild(deployed: DeployedBuild): BuildComparison {
  if (deployed.sha === GIT_SHA) {
    return 'current';
  }
  if (deployed.run !== null && RUNNING_RUN !== null && deployed.run <= RUNNING_RUN) {
    return 'older';
  }
  return 'newer';
}
