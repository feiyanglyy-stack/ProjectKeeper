/**
 * Opening pi's own interface in a terminal, for `Open in pi` on a system that is not Windows (runtime.ts keeps the
 * Windows way: a console window started with `start`).
 *
 * macOS: a small script is written to the temporary directory and handed to Terminal (`open -a Terminal <script>`),
 * which runs a `.command` file in a new window. That needs no permission from the owner; telling Terminal what to do
 * through AppleScript would need macOS's leave for one program to control another, which can be refused without a
 * word. What is reported is what happened: Terminal was asked and `open` said yes, or it was not and why.
 *
 * Anywhere else there is no one terminal to open, so nothing is started and the answer is the command to run. (Started
 * with no terminal at all, as it used to be, pi showed nothing and the workbench said it had been opened.)
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A word for `sh`, whatever it holds: a space, a quote, a `$`. */
export const shellWord = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;

/** The line that opens pi in a project's directory, resuming a session when one is given: what the script runs, and what the owner is shown to run. */
export function piCommandLine(cwd: string, sessionFile: string | null, pi = 'pi'): string {
  return `cd ${shellWord(cwd)} && ${pi === 'pi' ? 'pi' : shellWord(pi)}${sessionFile ? ` --session ${shellWord(sessionFile)}` : ''}`;
}

/** The script Terminal runs: go to the project, then become pi (so closing pi ends the window's process). */
export function openInPiScript(cwd: string, sessionFile: string | null, pi = 'pi'): string {
  return `#!/bin/sh\ncd ${shellWord(cwd)} || exit 1\nexec ${pi === 'pi' ? 'pi' : shellWord(pi)}${sessionFile ? ` --session ${shellWord(sessionFile)}` : ''}\n`;
}

const runnable = (path: string): boolean => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } };

/** pi's command: the one on the PATH, else the one installed with ProjectKeeper; null when there is neither. */
export function findPi(pathVariable: string = process.env.PATH ?? '', installed: string = fileURLToPath(new URL('../../node_modules/.bin/pi', import.meta.url))): string | null {
  for (const dir of pathVariable.split(delimiter)) if (dir && runnable(join(dir, 'pi'))) return 'pi';
  return runnable(installed) ? installed : null;
}

export function openInPiOffWindows(cwd: string, sessionFile: string | null, platform: NodeJS.Platform = process.platform): { message: string } {
  const yourself = (pi: string) => `run it yourself in a terminal: ${piCommandLine(cwd, sessionFile, pi)}`;
  if (platform !== 'darwin') return { message: `Opening a terminal is not available on this system; ${yourself('pi')}` };
  const pi = findPi();
  if (!pi) return { message: `pi’s command was not found, neither on the PATH nor installed with ProjectKeeper, so nothing was opened; once it is installed, ${yourself('pi')}` };
  try {
    const script = join(mkdtempSync(join(tmpdir(), 'pk-open-in-pi-')), 'open-in-pi.command');
    writeFileSync(script, openInPiScript(cwd, sessionFile, pi), { mode: 0o700 });
    const asked = spawnSync('open', ['-a', 'Terminal', script], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (asked.error || asked.status !== 0) {
      const why = asked.error?.message ?? ((asked.stderr || asked.stdout || '').trim().split('\n')[0] || `open ended with ${asked.status ?? asked.signal}`);
      return { message: `Terminal could not be opened (${why}), so pi was not started; ${yourself(pi)}` };
    }
    return { message: `Asked Terminal to open pi in ${cwd}${sessionFile ? ' with the Keeper session' : ''}` };
  } catch (e) {
    return { message: `Could not open pi: ${(e as Error).message}; ${yourself(pi)}` };
  }
}
