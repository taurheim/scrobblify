import { PostHogAnalytics } from '../src/analytics';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

async function main() {
  console.log('\n-- PostHog worker capture --');
  {
    const requests: { url: string; init?: RequestInit }[] = [];
    const analytics = new PostHogAnalytics({
      token: 'public-project-token',
      host: 'https://example.posthog.test/',
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return new Response(null, { status: 200 });
      },
    });

    await analytics.capture('scrobble_started', 'listener', {
      app: 'attempted-override',
      execution: 'background',
      job_id: 'job-1',
    });

    check('capture uses the PostHog HTTP endpoint',
      requests[0]?.url === 'https://example.posthog.test/capture/', requests);
    const body = JSON.parse(String(requests[0]?.init?.body));
    check('capture uses the configured public ingestion token',
      body.api_key === 'public-project-token', body);
    check('capture preserves the event name', body.event === 'scrobble_started', body);
    check('capture associates the Last.fm username as distinct_id',
      body.properties.distinct_id === 'listener', body.properties);
    check('capture always forces the shared-project app tag',
      body.properties.app === 'scrobblify', body.properties);
    check('capture preserves safe worker properties',
      body.properties.execution === 'background' && body.properties.job_id === 'job-1',
      body.properties);
  }

  console.log('\n-- analytics never affects worker work --');
  {
    const analytics = new PostHogAnalytics({
      token: 'public-project-token',
      host: 'https://example.posthog.test',
      fetch: async () => { throw new Error('analytics unavailable'); },
    });
    let rejected = false;
    try {
      await analytics.capture('scrobble_completed', 'listener', {});
    } catch {
      rejected = true;
    }
    check('transport failures are swallowed', !rejected);
  }

  console.log('\n-- analytics can be explicitly disabled --');
  {
    let calls = 0;
    const analytics = new PostHogAnalytics({
      token: '',
      host: 'https://example.posthog.test',
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    });
    await analytics.capture('scrobble_started', 'listener', {});
    check('an empty ingestion token makes capture a no-op', calls === 0, calls);
  }

  console.log('\n-- incomplete analytics configuration is harmless --');
  {
    let calls = 0;
    const analytics = new PostHogAnalytics({
      token: 'public-project-token',
      host: '',
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 200 });
      },
    });
    await analytics.capture('scrobble_started', 'listener', {});
    check('an empty capture host makes capture a no-op', calls === 0, calls);
  }

  console.log('\n-- Cloudflare keeps detached delivery alive --');
  {
    let pending: Promise<unknown> | undefined;
    const analytics = new PostHogAnalytics({
      token: 'public-project-token',
      host: 'https://example.posthog.test',
      fetch: async () => new Response(null, { status: 200 }),
      waitUntil: (promise) => { pending = promise; },
    });
    await analytics.capture('scrobble_started', 'listener', {});
    check('capture registers its detached request with ExecutionContext.waitUntil', !!pending);
    await pending;
  }

  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
