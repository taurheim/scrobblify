/**
 * Test schema loader.
 *
 * Applies every migration in order rather than just `001_init.sql`, so a test
 * database matches what a deployed one would look like. Loading only the
 * initial file would let a migration that is never applied — or one that is
 * invalid SQL — pass the whole suite.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_DIR = join(__dirname, '..', 'schema');

export function schemaSql(): string {
  return readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(SCHEMA_DIR, f), 'utf8'))
    .join('\n');
}
