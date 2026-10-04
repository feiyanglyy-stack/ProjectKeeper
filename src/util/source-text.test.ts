/**
 * Source files hold text only (batch D2; independent review AK, P2). A literal NUL byte inside a template string made
 * git treat the whole file as binary — no diff, grep skipping its content, some file readers refusing it — so a review
 * or a merge could not see what changed there. A separator that has to be NUL is written as the escape `\0`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
/** The kinds of source file kept under src/ and scripts/. */
const SOURCE = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md', '.ps1', '.psm1']);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (SOURCE.has(extname(entry.name).toLowerCase())) yield path;
  }
}

test('no source file under src/ or scripts/ holds a NUL byte', () => {
  const found: string[] = [];
  let scanned = 0;
  for (const top of ['src', 'scripts']) {
    for (const file of sourceFiles(join(ROOT, top))) {
      scanned++;
      const bytes = readFileSync(file);
      const at = bytes.indexOf(0);
      if (at >= 0) found.push(`${relative(ROOT, file)}:${bytes.subarray(0, at).toString('utf8').split('\n').length}`);
    }
  }
  assert.ok(scanned > 100, `the scan reached the source tree (${scanned} files)`);
  assert.deepEqual(found, [], `a NUL byte makes git treat the file as binary; write the separator as the escape \\0: ${found.join(', ')}`);
});
