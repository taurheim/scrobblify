import { GIT_SHA } from '../buildInfo';

/*
  Detects a tab running an older build than the one deployed.

  Browsers keep serving an old index.html (heuristic caching, restored or
  discarded tabs), and the FTP deploy leaves old hashed chunks in place, so a
  stale page still boots fine and runs code missing every fix since. In
  telemetry this showed up as users on builds days to months old, still hitting
  bugs that had been fixed for them.

  CI writes version.json next to index.html on every build (see ci.yml), so the
  deployed build is one no-store fetch away. A missing or malformed file, as on
  a local dev server, means "unknown", never "stale".
*/

export interface DeployedBuild {
  sha: string;
  run: number | null;
}

const VERSION_URL = `${process.env.BASE_URL || '/'}version.json`;

export async function fetchDeployedBuild(): Promise<DeployedBuild | null> {
  try {
    const response = await fetch(VERSION_URL, { cache: 'no-store' });
    if (!response.ok) {
      return null;
    }
    const body = await response.json();
    if (!body || typeof body.sha !== 'string' || !/^[0-9a-f]{7}$/.test(body.sha)) {
      return null;
    }
    return { sha: body.sha, run: typeof body.run === 'number' ? body.run : null };
  } catch (e) {
    return null;
  }
}

export function isStaleBuild(deployed: DeployedBuild): boolean {
  return deployed.sha !== GIT_SHA;
}
