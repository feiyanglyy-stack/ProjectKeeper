/**
 * Git in the Keeper's shell, by allowlist (Spec §3.1; CKC-26 AC-8). The Keeper only reads a project, so a git
 * subcommand runs when it is known to only read, and is refused otherwise. It used to be the other way round — a
 * list of the subcommands that write, everything else allowed — and the list missed plenty (`update-ref`,
 * `filter-branch`, `remote set-url`, `notes add`, `hash-object -w`, `config --unset-all`, `difftool -x <program>`),
 * let any alias of the repository's own configuration run (`alias.st = !rm -rf .`), and at the same time refused
 * listings it took for writes (`branch --contains X`, `tag -l 'v*'`, `stash list`).
 *
 * Per subcommand: the forms that run and the forms that are refused, each refusal with its kind — it changes the
 * repository, it reaches a remote, it has git run another program, or the check does not know it. Then the options
 * and settings that turn a reading command into one of those. Nothing is run; the check is asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkShellCommand, planShellCommand } from './command.ts';
import { canonicalKey, makeBoundary } from './paths.ts';

const base = mkdtempSync(join(tmpdir(), 'pk-git-allow-'));
const project = join(base, 'project');
const scratch = join(base, 'scratch');
const outside = join(base, 'outside').replaceAll('\\', '/');
mkdirSync(join(project, 'src'), { recursive: true });
mkdirSync(scratch);
mkdirSync(outside);
writeFileSync(join(project, 'src', 'a.ts'), 'x');
writeFileSync(join(outside, 'secret.txt'), 'x');
const boundary = makeBoundary({ roots: [{ path: project, label: 'the project directory' }, { path: scratch, label: 'scratch' }], files: [] });
const decide = (command: string, shell: 'bash' | 'powershell' = 'bash') => checkShellCommand(shell, command, project, boundary, [project], scratch);

const KIND = {
  writes: /shell cannot write project files/,
  outward: /reaches a remote/,
  runs: /have git run another program/,
  unknown: /is not a git command this check knows to only read/,
  setting: /is not a setting this check knows to be harmless/,
  boundary: /read boundary/,
  computed: /cannot be checked before it runs/,
} as const;
const runs = (command: string) => assert.deepEqual(decide(command), { ok: true, reason: null, detail: null }, command);
const refused = (command: string, kind: keyof typeof KIND) => {
  const d = decide(command);
  assert.equal(d.ok, false, `expected refused: ${command}`);
  assert.match(d.reason ?? '', KIND[kind], command);
};

/** Subcommands that only read, with the options agents use on them. */
const READS = [
  'git status', 'git status --short', 'git status --porcelain', 'git status -sb', 'git --no-optional-locks status --porcelain=v1 --untracked-files=all',
  'git log', 'git log --oneline -20', 'git log --all --graph --format=%h%x09%s --date=short --since=2026-09-01 --until=2026-09-30', 'git log --follow --stat -- src/a.ts', 'git log -S needle --pretty=oneline',
  'git log -G needle -i --name-status', 'git log --merges --first-parent --reverse main', 'git log --grep=K-1 -E --no-merges', 'git log -p -3 --no-color', 'git log --ancestry-path a..b --source --tags --no-decorate',
  'git show HEAD', 'git show HEAD:src/a.ts', 'git show --stat --format=%an HEAD~2', 'git show -s --no-patch HEAD', 'git show --name-only --diff-filter=AM HEAD',
  'git diff', 'git diff HEAD~3 -- src', 'git diff --stat main...side', 'git diff --name-only --diff-filter=D', 'git diff --ignore-cr-at-eol --no-color', 'git diff --cached', 'git diff --no-index src/a.ts src/a.ts',
  'git blame src/a.ts', 'git blame -L 1,5 --porcelain src/a.ts', 'git annotate src/a.ts', 'git shortlog -sn', 'git whatchanged -3', 'git grep -n needle', 'git grep -i -l needle -- src', 'git grep -c needle HEAD',
  'git ls-files', 'git ls-files --others --exclude-standard', 'git ls-tree --name-only -r HEAD', 'git cat-file -t HEAD', 'git cat-file -p HEAD:src/a.ts', 'git cat-file -e HEAD', 'git cat-file -s HEAD', 'git cat-file --batch-check',
  'git rev-parse HEAD', 'git rev-parse --verify -q main', 'git rev-parse --short HEAD', 'git rev-parse --is-inside-work-tree', 'git rev-parse --show-toplevel', 'git rev-list --count HEAD', 'git rev-list --no-walk --all',
  'git merge-base main side', 'git merge-base --is-ancestor a b', 'git name-rev HEAD', 'git describe --tags --always', 'git for-each-ref --format=%(refname) refs/heads', 'git show-ref', 'git show-branch',
  'git diff-tree --no-commit-id --name-only -r HEAD', 'git diff-index HEAD', 'git diff-files', 'git range-diff a..b c..d', 'git cherry main', 'git check-ignore -v src/a.ts', 'git check-attr -a src/a.ts',
  'git var GIT_AUTHOR_IDENT', 'git count-objects -v', 'git verify-pack -v .git/objects/pack/pack-x.idx'.replace('.git/objects/pack/pack-x.idx', 'src/a.ts'), 'git fsck', 'git fsck --no-dangling', 'git version', 'git --version',
  'git -C src log -1', 'git -C . status', 'git --no-pager log -1', 'git -P diff', 'git log -h',
];

test('git subcommands that only read run, with the options agents use on them', () => {
  for (const command of READS) runs(command);
});

/** Subcommands with forms that list and forms that write: [what runs, what is refused and why]. */
const BY_FORM: Readonly<Record<string, { runs: readonly string[]; refused: readonly (readonly [string, keyof typeof KIND])[] }>> = {
  branch: {
    runs: ['git branch', 'git branch -a', 'git branch -r', 'git branch -v', 'git branch -vv', 'git branch --list', 'git branch --list "feat/*"', 'git branch --list -a "feat/*"', 'git branch -l', 'git branch --show-current',
      'git branch --contains HEAD', 'git branch --contains', 'git branch -a --contains HEAD~3', 'git branch --no-contains main', 'git branch --merged', 'git branch --merged main', 'git branch --no-merged', 'git branch --no-merged main -a',
      'git branch --points-at HEAD', 'git branch --format=%(refname:short) --sort=-committerdate', 'git branch --sort -committerdate --format "%(refname)"', 'git branch --no-color -a', 'git branch --contains HEAD --format=%(refname) --no-color'],
    refused: [['git branch side', 'writes'], ['git branch side main', 'writes'], ['git branch -d side', 'writes'], ['git branch -D side', 'writes'], ['git branch -m old new', 'writes'], ['git branch -M new', 'writes'], ['git branch -c a b', 'writes'],
      ['git branch -f side HEAD~1', 'writes'], ['git branch --delete side', 'writes'], ['git branch -u origin/main', 'writes'], ['git branch --set-upstream-to=origin/main', 'writes'], ['git branch --unset-upstream', 'writes'],
      ['git branch --edit-description', 'writes'], ['git branch -v side', 'writes'], ['git branch --track side origin/side', 'writes']],
  },
  tag: {
    runs: ['git tag', 'git tag -l', 'git tag -l "v*"', 'git tag --list "v*" --sort=-creatordate', 'git tag -n', 'git tag -n3 -l', 'git tag --contains HEAD', 'git tag --merged main', 'git tag --points-at HEAD', 'git tag --format=%(refname) -l', 'git tag -v v1'],
    refused: [['git tag v1', 'writes'], ['git tag v1 HEAD~1', 'writes'], ['git tag -a v1 -m x', 'writes'], ['git tag -d v1', 'writes'], ['git tag -f v1', 'writes'], ['git tag -s v1', 'writes'], ['git tag --delete v1', 'writes']],
  },
  remote: {
    runs: ['git remote', 'git remote -v', 'git remote --verbose', 'git remote get-url origin', 'git remote get-url --all origin', 'git remote show -n origin'],
    refused: [['git remote add x https://example.invalid/x', 'writes'], ['git remote remove x', 'writes'], ['git remote rm x', 'writes'], ['git remote rename a b', 'writes'], ['git remote set-url origin https://example.invalid/x', 'writes'],
      ['git remote set-head origin -a', 'writes'], ['git remote set-branches origin main', 'writes'], ['git remote show origin', 'outward'], ['git remote update', 'outward'], ['git remote prune origin', 'outward']],
  },
  stash: {
    runs: ['git stash list', 'git stash show', 'git stash show -p stash@{0}', 'git stash list --format=%gd'],
    refused: [['git stash', 'writes'], ['git stash push', 'writes'], ['git stash pop', 'writes'], ['git stash apply', 'writes'], ['git stash drop', 'writes'], ['git stash clear', 'writes'], ['git stash -u', 'writes'], ['git stash create', 'writes'], ['git stash branch x', 'writes']],
  },
  worktree: {
    runs: ['git worktree list', 'git worktree list --porcelain', 'git worktree list -v'],
    refused: [['git worktree add ../new', 'writes'], ['git worktree remove ../new', 'writes'], ['git worktree prune', 'writes'], ['git worktree move a b', 'writes'], ['git worktree lock a', 'writes'], ['git worktree', 'writes']],
  },
  config: {
    runs: ['git config --local --list', 'git config --local -l', 'git config --local --get user.name', 'git config --local user.name', 'git config --local --get-regexp "^remote"', 'git config --local --get-all remote.origin.fetch',
      'git config --local get user.name', 'git config --local list', 'git config --file src/a.ts --list'],
    refused: [['git config --local user.name Someone', 'writes'], ['git config --local --add a.b c', 'writes'], ['git config --local --unset user.name', 'writes'], ['git config --local --unset-all user.name', 'writes'],
      ['git config --local --replace-all a.b c', 'writes'], ['git config --local --rename-section a b', 'writes'], ['git config --local --remove-section a', 'writes'], ['git config --local --edit', 'writes'], ['git config --local -e', 'writes'],
      ['git config --local set user.name x', 'writes'], ['git config --local unset user.name', 'writes'], ['git config --local edit', 'writes'], ['git config --local rename-section a b', 'writes'], ['git config --local remove-section a', 'writes'], ['git config set user.name x', 'writes']],
  },
  notes: {
    runs: ['git notes', 'git notes list', 'git notes show HEAD', 'git notes get-ref', 'git notes --ref=review list'],
    refused: [['git notes add -m x', 'writes'], ['git notes append -m x', 'writes'], ['git notes edit', 'writes'], ['git notes remove HEAD', 'writes'], ['git notes copy a b', 'writes'], ['git notes merge x', 'writes'], ['git notes prune', 'writes']],
  },
  reflog: {
    runs: ['git reflog', 'git reflog show', 'git reflog show main', 'git reflog -5', 'git reflog --date=iso', 'git reflog exists refs/heads/main', 'git reflog list'],
    refused: [['git reflog expire --all', 'writes'], ['git reflog delete HEAD@{1}', 'writes'], ['git reflog drop --all', 'writes']],
  },
  'symbolic-ref': {
    runs: ['git symbolic-ref HEAD', 'git symbolic-ref --short HEAD', 'git symbolic-ref -q HEAD'],
    refused: [['git symbolic-ref HEAD refs/heads/x', 'writes'], ['git symbolic-ref -d HEAD', 'writes'], ['git symbolic-ref --delete HEAD', 'writes'], ['git symbolic-ref -m why HEAD refs/heads/x', 'writes']],
  },
  bisect: {
    runs: ['git bisect log', 'git bisect terms'],
    refused: [['git bisect start', 'writes'], ['git bisect good', 'writes'], ['git bisect bad HEAD', 'writes'], ['git bisect reset', 'writes'], ['git bisect run npm test', 'writes'], ['git bisect', 'writes'], ['git bisect visualize', 'writes']],
  },
  submodule: {
    runs: ['git submodule', 'git submodule status', 'git submodule status --recursive', 'git submodule summary'],
    refused: [['git submodule update --init', 'writes'], ['git submodule add https://example.invalid/x', 'writes'], ['git submodule foreach "git push"', 'writes'], ['git submodule sync', 'writes'], ['git submodule deinit x', 'writes']],
  },
  'sparse-checkout': {
    runs: ['git sparse-checkout list', 'git sparse-checkout check-rules'],
    refused: [['git sparse-checkout set src', 'writes'], ['git sparse-checkout add src', 'writes'], ['git sparse-checkout init', 'writes'], ['git sparse-checkout disable', 'writes'], ['git sparse-checkout reapply', 'writes']],
  },
  lfs: {
    runs: ['git lfs ls-files', 'git lfs status', 'git lfs env', 'git lfs version', 'git lfs track'],
    refused: [['git lfs push origin main', 'outward'], ['git lfs pull', 'outward'], ['git lfs fetch', 'outward'], ['git lfs track "*.bin"', 'writes'], ['git lfs untrack "*.bin"', 'writes'], ['git lfs install', 'writes'], ['git lfs prune', 'writes'], ['git lfs migrate import', 'writes'], ['git lfs checkout', 'writes']],
  },
  'hash-object': {
    runs: ['git hash-object src/a.ts', 'git hash-object --stdin', 'git hash-object -t blob --path=src/a.ts -- src/a.ts'],
    refused: [['git hash-object -w src/a.ts', 'writes'], ['git hash-object --stdin -w', 'writes'], [`git hash-object ${outside}/secret.txt`, 'boundary']],
  },
  bundle: {
    runs: ['git bundle verify src/a.ts', 'git bundle list-heads src/a.ts', 'git bundle create "$TMPDIR/x.bundle" HEAD'],
    refused: [['git bundle create src/x.bundle HEAD', 'writes'], ['git bundle unbundle src/a.ts', 'writes'], [`git bundle verify ${outside}/x.bundle`, 'boundary']],
  },
  'format-patch': {
    runs: ['git format-patch -1 --stdout', 'git format-patch -1 -o "$TMPDIR/patches"', 'git format-patch --output-directory "$TMPDIR/p" HEAD~2'],
    refused: [['git format-patch -1', 'writes'], ['git format-patch -1 -o src/patches', 'writes'], ['git format-patch HEAD~3 --output-directory=patches', 'writes']],
  },
  archive: {
    runs: ['git archive HEAD', 'git archive --format=zip -o "$TMPDIR/x.zip" HEAD', 'git archive --output="$TMPDIR/x.tar" HEAD src'],
    refused: [['git archive -o src/x.zip HEAD', 'writes'], ['git archive --output=x.tar HEAD', 'writes'], ['git archive --remote=origin HEAD', 'outward'], ['git archive --exec=/tmp/x --remote=origin HEAD', 'outward']],
  },
  fsck: { runs: ['git fsck', 'git fsck --full --no-dangling'], refused: [['git fsck --lost-found', 'writes']] },
};

for (const [subcommand, forms] of Object.entries(BY_FORM)) {
  test(`git ${subcommand}: the forms that only read run, the ones that write or reach out are refused`, () => {
    for (const command of forms.runs) runs(command);
    for (const [command, kind] of forms.refused) refused(command, kind);
  });
}

test('git subcommands that change the repository are refused as writes, each of them', () => {
  for (const command of [
    'git add -A', 'git am x.patch', 'git apply x.patch', 'git checkout main', 'git checkout -b x', 'git checkout -- src/a.ts', 'git cherry-pick HEAD~1', 'git clean -fd', 'git commit -m x', 'git commit --amend', 'git gc', 'git init',
    'git maintenance run', 'git merge side', 'git mv a b', 'git rebase main', 'git repack -ad', 'git reset --hard', 'git restore src/a.ts', 'git revert HEAD', 'git rm src/a.ts', 'git switch main', 'git update-index --refresh',
    'git filter-branch --force HEAD', 'git update-ref refs/heads/main HEAD~1', 'git replace HEAD HEAD~1', 'git prune', 'git fast-import', 'git pack-refs --all', 'git checkout-index -a', 'git read-tree HEAD', 'git commit-tree HEAD^{tree} -m x',
    'git write-tree', 'git merge-tree --write-tree main side', 'git rerere forget src/a.ts', 'git mktag', 'git mktree', 'git unpack-objects', 'git prune-packed', 'git multi-pack-index write', 'git commit-graph write', 'git merge-file a b c',
    'git stage src/a.ts', 'git bugreport', 'git diagnose', 'git mailsplit x', 'git quiltimport', 'git cvsimport', 'git fast-export --all',
  ]) refused(command, command === 'git fast-export --all' ? 'unknown' : 'writes');
});

test('git subcommands that reach a remote are refused as that, not as writes to the project', () => {
  for (const command of [
    'git push', 'git push origin main', 'git push --force-with-lease', 'git fetch', 'git fetch origin', 'git pull', 'git pull --rebase', 'git clone https://example.invalid/x', 'git ls-remote origin', 'git ls-remote --heads origin',
    'git send-email --to someone@example.invalid 0001.patch', 'git send-email --dry-run 0001.patch', 'git imap-send', 'git request-pull HEAD~1 origin', 'git svn dcommit', 'git svn fetch', 'git p4 submit',
    'git send-pack origin', 'git fetch-pack origin', 'git http-push https://example.invalid/x', 'git daemon', 'git archive --remote=origin HEAD', 'git remote update', 'git lfs push origin main',
  ]) {
    refused(command, 'outward');
    assert.doesNotMatch(decide(command).reason ?? '', /cannot write project files/, command);
  }
});

test('a git subcommand the check does not know is refused: an alias of the repository’s own configuration, a program named git-<x>, a typo', () => {
  // `.git/config` belongs to the project and can hold `alias.st = !rm -rf .`; what an unknown word does is not known.
  mkdirSync(join(project, '.git'), { recursive: true });
  writeFileSync(join(project, '.git', 'config'), '[alias]\n\tst = !rm -rf .\n\tlg = log --oneline\n');
  for (const command of ['git st', 'git lg -3', 'git frobnicate', 'git gui', 'git citool', 'git instaweb', 'git flow init', 'git subtree push --prefix=x origin main', 'git sttaus', 'git absorb', 'git extras']) refused(command, 'unknown');
  // A subcommand the shell computes cannot be known.
  refused('git $VERB', 'computed');
  refused('git "$@"', 'computed');
});

test('an option or a setting that has a reading command run a program, write a file or look elsewhere is refused', () => {
  // git runs another program
  for (const command of [
    'git difftool HEAD~1', 'git difftool -y -x "rm -rf src" HEAD~1', 'git mergetool', 'git log --ext-diff -p', 'git show --ext-diff', 'git diff --ext-diff', 'git grep --open-files-in-pager=less needle', 'git grep -Oless needle', 'git grep -O needle',
    'git cat-file --textconv HEAD:src/a.ts', 'git cat-file --filters HEAD:src/a.ts', 'git grep --textconv needle', 'git --paginate log', 'git -p log', 'git --exec-path=/tmp/x log', 'git log --help', 'git help log', 'git status --help',
  ]) refused(command, 'runs');
  // settings given for one command
  for (const command of [
    "git -c core.pager='rm -rf src' log", 'git -c core.pager=less log', "git -c diff.external='rm -rf src' diff", "git -c core.fsmonitor='rm -rf src' status", "git -c core.sshCommand='rm -rf src' log", "git -c core.editor=vim log",
    "git -c diff.docx.textconv=cat diff", 'git -c core.hooksPath=hooks log', 'git -c core.worktree=/tmp log', 'git -c credential.helper=store log', 'git -c include.path=/tmp/x log', 'git -c pager.log=less log',
    'git -c url.https://example.invalid/.insteadOf=x log', 'git --config-env core.pager=PAGER log', 'git --config-env=core.pager=PAGER log', 'git -c frobnicate.x=y log',
  ]) refused(command, 'setting');
  assert.equal(decide('git -c alias.z=status z').ok, false, 'an alias made on the spot');
  for (const command of [
    'git -c core.quotePath=false ls-files', 'git -c color.ui=false log -1', 'git -c core.pager=cat log -1', 'git -c core.pager= log -1', 'git -c pager.log=false log -1', 'git -c core.fsmonitor=false status', 'git -c log.showSignature=false log -1',
    'git -c diff.renames=true diff', 'git -c diff.renameLimit=999 diff', 'git -c core.autocrlf=false diff', 'git -c core.longpaths=true status', 'git -c safe.directory=* status', 'git -c i18n.logOutputEncoding=utf-8 log -1', 'git -c core.abbrev=12 log -1',
    'git -c user.name=x var GIT_AUTHOR_IDENT', 'git -c grep.lineNumber=true grep needle', 'git -c blame.showEmail=true blame src/a.ts', 'git -c status.showUntrackedFiles=all status', 'git -c advice.detachedHead=false log -1',
  ]) runs(command);
  // the same through the environment, set for the command
  for (const command of [
    "GIT_EXTERNAL_DIFF='rm -rf src' git diff", "GIT_SSH_COMMAND='rm -rf src' git log", 'GIT_SSH=plink git log', "GIT_PAGER='rm -rf src' git log", 'GIT_EDITOR=vim git log', 'GIT_SEQUENCE_EDITOR=vim git log', 'GIT_ASKPASS=helper git log',
    'GIT_EXEC_PATH=libexec git log', 'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.z GIT_CONFIG_VALUE_0="!rm -rf src" git log', "GIT_CONFIG_PARAMETERS=\"'alias.z'='!x'\" git log", 'PAGER=less git log', 'env GIT_EXTERNAL_DIFF=x git diff', 'export GIT_PAGER=less',
  ]) refused(command, 'runs');
  for (const command of ['GIT_PAGER=cat git log -1', 'PAGER=cat git log -1', 'GIT_PAGER= git log -1', 'GIT_OPTIONAL_LOCKS=0 git status', 'GIT_TERMINAL_PROMPT=0 git log -1', 'LC_ALL=C git log -1', 'TZ=UTC git log -1 --date=iso-local']) runs(command);
  // a file written from a reading command: the job's scratch directory only
  for (const command of ['git log --output=src/log.txt -3', 'git diff --output=diff.txt', 'git show --output src/show.txt HEAD']) refused(command, 'writes');
  runs('git log --output="$TMPDIR/log.txt" -3');
  refused('git log --output="$SOMEWHERE/log.txt" -3', 'computed');
  refused('git diff --output $OUT', 'computed');
  assert.deepEqual(planShellCommand('bash', 'git diff --output="$TMPDIR/d.txt"', project, boundary, [project], scratch).writePaths, [canonicalKey(join(scratch, 'd.txt'), project)]);
  // files compared or read outside any repository are paths like any other
  refused(`git diff --no-index ${outside}/secret.txt src/a.ts`, 'boundary');
  refused(`git grep --no-index needle ${outside}`, 'boundary');
  refused(`git blame --contents ${outside}/secret.txt src/a.ts`, 'boundary');
  runs('git grep --no-index needle src');
});

test('the same decisions behind a wrapper, in PowerShell, and in code given to an interpreter', () => {
  const wrappers: readonly ((c: string) => string)[] = [(c) => `env ${c}`, (c) => `timeout 5 ${c}`, (c) => `nice -n 5 ${c}`, (c) => `bash -lc ${JSON.stringify(c)}`, (c) => `if true; then ${c}; fi`, (c) => `find . -maxdepth 0 -exec ${c} \\;`, (c) => `( ${c} )`];
  for (const command of ['git branch side', 'git stash', 'git remote set-url origin https://example.invalid/x', 'git update-ref refs/heads/main HEAD~1', 'git ls-remote origin', 'git st', 'git difftool HEAD~1', 'git -c core.pager=less log']) {
    for (const wrap of wrappers) assert.equal(decide(wrap(command)).reason, decide(command).reason, wrap(command));
    assert.equal(decide(command, 'powershell').reason, decide(command).reason, `PowerShell: ${command}`);
    assert.equal(decide(`& { ${command} }`, 'powershell').ok, false, `PowerShell block: ${command}`);
  }
  for (const command of ['git branch --contains HEAD', 'git stash list', 'git tag -l', 'git remote -v', 'git log --oneline -3', 'git status --porcelain']) {
    for (const wrap of wrappers) runs(wrap(command));
    assert.equal(decide(command, 'powershell').ok, true, `PowerShell: ${command}`);
  }
  for (const code of ["import subprocess; subprocess.run(['git', 'update-ref', 'refs/heads/main', 'HEAD~1'])", "import os; os.system('git st')", "import os; os.system('git stash')"]) assert.equal(decide(`python -c "${code}"`).ok, false, code);
  runs(`python -c "import subprocess; subprocess.run(['git', 'stash', 'list'])"`);
});
