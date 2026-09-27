/**
 * Last.fm signs requests with MD5. WebCrypto offers SHA-1/256/384/512 but not
 * MD5, so there is no platform primitive to fall back on — the hash runs in JS
 * on the Worker's CPU budget. Using the same library as the SPA keeps the
 * spike's measurement representative of production cost.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
import md5 from 'blueimp-md5';

export default md5 as (value: string) => string;
