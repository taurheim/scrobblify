import {
  buildLastFmErrorMessage,
  isInvalidSessionKeyError,
  isRateLimitError,
  isSuspendedApiKeyError,
  isNetworkError,
} from '../../src/shared/lastfm/protocol';

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown) {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function main() {
  console.log('\n-- Last.fm error privacy --');
  const params = {
    api_key: 'public-key',
    api_sig: 'signature',
    sk: 'session-key',
    'artist[0]': 'Private Artist',
    'track[0]': 'Private Track',
    'album[0]': 'Private Album',
    'timestamp[0]': '1800000000',
  };
  const message = buildLastFmErrorMessage(
    429,
    29,
    'Rate limit exceeded for Private Artist - Private Track',
    params,
    { includeRequestDetails: false },
  );

  check('message retains only classification-safe Last.fm context',
    message === 'Last.fm API error 29 (HTTP 429)', message);
  check('message contains no serialized request marker', !message.includes('Request:'), message);
  check('message contains no listening-history detail',
    !Object.values(params).some((value) => message.includes(value)), message);
  check('rate-limit classification still works', isRateLimitError(new Error(message)));

  const revoked = buildLastFmErrorMessage(
    403,
    9,
    'Invalid session key for Private Artist',
    params,
    { includeRequestDetails: false },
  );
  check('invalid-session classification still works',
    isInvalidSessionKeyError(new Error(revoked)), revoked);

  const suspended = buildLastFmErrorMessage(
    403,
    26,
    'This API key is suspended for Private Artist',
    params,
    { includeRequestDetails: false },
  );
  check('suspended-key classification still works',
    isSuspendedApiKeyError(new Error(suspended)), suspended);
  check('network classification still works',
    isNetworkError(new TypeError('Network request failed')));

  process.exitCode = failures === 0 ? 0 : 1;
}

main();
