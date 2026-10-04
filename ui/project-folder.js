// The project-folder authorization on the Keeper page (Spec §1.14): what the page says in each state, the words recorded
// as the owner's when they press Authorize, and what a grant did. Text only, so it is tested without a browser
// (src/ui/project-folder.test.ts); keeper-view.js draws it.

const same = (t) => t;

/** The state in one word, and the lines under the sentence that says what the authorization allows. */
export function folderStatus(pf, { time = same, rel = same } = {}) {
  if (pf.granted) {
    const w = pf.lastWrite;
    return {
      tag: 'granted', tone: 'green', action: 'withdraw',
      lines: [
        `Folder: ${pf.path}`,
        pf.commits ? 'The Keeper commits it itself: each commit contains only this folder and is never pushed.' : 'Write-only: the Keeper commits nothing; what it writes appears as uncommitted changes.',
        `Granted ${time(pf.grantedAt)} · ${w ? `last written ${rel(w.at)}${w.commit ? ` in commit ${w.commit.slice(0, 7)}` : ', not committed'}` : 'not written yet'}`,
      ],
    };
  }
  const lines = ['Not granted: the Keeper writes nothing into the project.'];
  if (pf.withdrawnAt) lines.push(`Withdrawn ${time(pf.withdrawnAt)}.${pf.exists ? ` ${pf.path} is still in the project, with its commits; it is yours to keep or delete.` : ''}`);
  return { tag: 'not granted', tone: '', action: 'grant', lines };
}

/** The owner's statement a press of Authorize stands for: it is recorded with the authorization, as their words are. */
export function grantWords({ folder, commits }) {
  const name = String(folder).replace(/[\\/]+$/, '');
  return `Authorized on the Keeper page: the Keeper may maintain ${name}/ in this project and ${commits ? 'commit that folder alone' : 'write it without committing'}; it never pushes.`;
}

/** What the grant did, for the message after it: the files written, the commit, or why there is none. */
export function grantOutcome(sync) {
  if (!sync || sync.status === 'not-authorized') return 'Authorized';
  const files = sync.changedFiles?.length ?? 0;
  const wrote = files ? `wrote ${files} file${files === 1 ? '' : 's'}` : 'the folder was already up to date';
  return `Authorized: ${wrote}${sync.commit ? `, commit ${sync.commit.slice(0, 7)}` : ''}${sync.reason ? `. ${sync.reason}` : ''}`;
}
