/**
 * Whether git is there, said once when the workbench starts.
 *
 * ProjectKeeper reads a project's history through git. Without git every read-only call answers "not a repository"
 * and a project with years of history looks like a folder of files, with nothing said. That is the usual state of a
 * new Mac: `/usr/bin/git` is a stand-in until the Xcode command line tools are installed, and running it only offers
 * to install them. An old git lacks options the reads use (`--path-format`, `--diff-merges`: 2.31).
 */
import { execFileSync } from 'node:child_process';

/** The oldest git whose options the reads use. */
export const GIT_MIN = [2, 31] as const;

/** What `git --version` printed, or null when git could not be run. */
export function gitVersionOutput(): string | null {
  try { return execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch { return null; }
}

/** What to tell the owner about the git this machine has; null when there is nothing to say. */
export function gitNotice(versionOutput: string | null, platform: NodeJS.Platform = process.platform): string | null {
  const install = platform === 'darwin' ? 'On macOS, install the Xcode command line tools (xcode-select --install) or git from Homebrew.'
    : platform === 'win32' ? 'Install Git for Windows (https://git-scm.com/download/win).'
      : 'Install git with your system’s package manager.';
  const m = versionOutput === null ? null : /git version (\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return `git was not found. ProjectKeeper reads a project’s history with git: without it a repository is read as a folder of files, with no commits, no earlier versions of documents and no worktrees. ${install} Then start the workbench again.`;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  if (major > GIT_MIN[0] || (major === GIT_MIN[0] && minor >= GIT_MIN[1])) return null;
  return `This machine’s git is ${major}.${minor}; ProjectKeeper needs ${GIT_MIN[0]}.${GIT_MIN[1]} or later to read a project’s history in full. ${install}`;
}
