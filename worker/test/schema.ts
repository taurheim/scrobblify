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
const BLOB_SCHEMA_DIR = join(__dirname, '..', 'schema-blobs');

function readDir(dir: string): string {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

export function schemaSql(): string {
  return readDir(SCHEMA_DIR);
}

/** The separate blob database's schema. */
export function blobSchemaSql(): string {
  return readDir(BLOB_SCHEMA_DIR);
}
