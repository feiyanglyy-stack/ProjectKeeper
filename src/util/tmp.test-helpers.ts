/**
 * The system's temporary directory, for tests that compare the paths ProjectKeeper reports with the ones they made.
 *
 * `os.tmpdir()` gives the directory as the environment spells it, and that is often not the file system's own spelling:
 * on Windows `%TEMP%` is a short (8.3) name whenever the user name is longer than eight characters or has a space in it
 * (`C:\Users\RUNNER~1\AppData\Local\Temp` on a GitHub runner), and on macOS `/var/folders/…` is a link into `/private`.
 * ProjectKeeper keeps every location in the file system's spelling (util/paths.ts `canonicalPath`), so a test that
 * builds a project under the temporary directory and then looks for `join(dir, 'docs')` among the paths it gets back
 * has to start from that spelling too. Import `tmpdir` from here instead of `node:os` for that.
 *
 * A test that hands ProjectKeeper another spelling on purpose says so (src/qc/path-spelling.test.ts).
 */
import { tmpdir as systemTmpdir } from 'node:os';
import { canonicalPath } from './paths.ts';

export function tmpdir(): string {
  return canonicalPath(systemTmpdir());
}
