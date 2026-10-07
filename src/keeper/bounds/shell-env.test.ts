/**
 * The environment a shell command of the Keeper gets (PA-10): credential-named variables are gone, and git's settings
 * group (`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_VALUE_<n>`) is rebuilt from the settings that hold no
 * secret, so git in that shell runs. Before, the filter took the `…_KEY_<n>` names for credentials and left the count
 * and the values: every git command stopped with "missing config key", and a secret in a value passed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLocalGitSetting, shellEnv, stripCredentialEnv } from './boundary.ts';

/** An environment with nothing of git's from the machine the test runs on, and the given settings group. */
function envWith(settings: readonly (readonly [string, string])[], extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), 'pk-shell-env-'));
  writeFileSync(join(dir, 'gitconfig'), '');
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.toUpperCase().startsWith('GIT_')) env[k] = v;
  Object.assign(env, { GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: String(settings.length) });
  settings.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${i}`] = key; env[`GIT_CONFIG_VALUE_${i}`] = value; });
  return { ...env, ...extra };
}
const group = (env: NodeJS.ProcessEnv): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(env).filter(([k]) => /^GIT_CONFIG_(COUNT|KEY_|VALUE_|PARAMETERS)/i.test(k)).sort(([a], [b]) => a.localeCompare(b)));
const gitWith = (env: NodeJS.ProcessEnv, args: readonly string[]): string =>
  execFileSync('git', args, { env, cwd: tmpdir(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const SETTINGS = [
  ['user.name', 'Invented Name'],
  ['http.https://example.invalid/.extraheader', 'AUTHORIZATION: bearer invented-bearer-1234'],
  ['safe.directory', '*'],
  ['url.https://bot:invented-token-5678@example.invalid/.insteadOf', 'https://example.invalid/'],
  ['core.longpaths', 'true'],
  ['credential.helper', '!f() { echo password=invented-password-9012; }; f'],
  ['safe.directory', '/somewhere/else'],
] as const;

test('git settings given through the environment: the ones that hold no secret stay, numbered from 0 again, and git runs', () => {
  const before = envWith(SETTINGS);
  assert.equal(gitWith(before, ['config', '--get', 'user.name']).trim(), 'Invented Name', 'the settings as given are ones git reads');
  const env = stripCredentialEnv(before);
  assert.deepEqual(group(env), {
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Invented Name',
    GIT_CONFIG_KEY_1: 'safe.directory', GIT_CONFIG_VALUE_1: '*',
    GIT_CONFIG_KEY_2: 'core.longpaths', GIT_CONFIG_VALUE_2: 'true',
    GIT_CONFIG_KEY_3: 'safe.directory', GIT_CONFIG_VALUE_3: '/somewhere/else',
  });
  // Git itself, with that environment: it runs, reads what stayed, and knows nothing of what went.
  assert.equal(gitWith(env, ['config', '--get', 'user.name']).trim(), 'Invented Name');
  assert.deepEqual(gitWith(env, ['config', '--get-all', 'safe.directory']).trim().split(/\r?\n/), ['*', '/somewhere/else'], 'a setting given twice keeps both values, in order');
  const all = gitWith(env, ['config', '--list']);
  assert.match(all, /core\.longpaths=true/);
  assert.doesNotMatch(all, /extraheader|insteadof|credential/i);
});

test('no secret of the git settings group is left anywhere in the environment', () => {
  const env = stripCredentialEnv(envWith(SETTINGS, { GIT_CONFIG_KEY_9: 'http.extraheader', GIT_CONFIG_VALUE_9: 'AUTHORIZATION: basic invented-basic-3456' }));
  const text = JSON.stringify(env);
  for (const secret of ['invented-bearer-1234', 'invented-token-5678', 'invented-password-9012', 'invented-basic-3456']) assert.ok(!text.includes(secret), `${secret} is gone`);
});

test('a group with nothing left is gone whole, and git runs', () => {
  const env = stripCredentialEnv(envWith([['http.extraheader', 'AUTHORIZATION: bearer invented-bearer-1234'], ['credential.username', 'someone']]));
  assert.deepEqual(group(env), {});
  assert.match(gitWith(env, ['config', '--list']), /^$/);
});

test('the group is found whatever the case of its variable names, as Windows reads them', () => {
  const env = stripCredentialEnv({ git_config_count: '2', Git_Config_Key_0: 'http.extraheader', Git_Config_Value_0: 'AUTHORIZATION: bearer invented-bearer-1234', git_config_key_1: 'user.email', git_config_value_1: 'someone@example.invalid' });
  assert.deepEqual(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.email', GIT_CONFIG_VALUE_0: 'someone@example.invalid' });
});

test('a group git itself could not read is cut where git would stop, not passed on half', () => {
  // The count says three; the second setting has no value. Git stops there with an error; the shell gets the first one.
  const env = stripCredentialEnv({ GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Invented Name', GIT_CONFIG_KEY_1: 'core.autocrlf', GIT_CONFIG_KEY_2: 'core.longpaths', GIT_CONFIG_VALUE_2: 'true' });
  assert.deepEqual(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Invented Name' });
  assert.deepEqual(stripCredentialEnv({ GIT_CONFIG_COUNT: 'many', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Invented Name' }), {}, 'a count that is not a number');
});

test('the settings one git command hands to its children are not passed on', () => {
  const env = stripCredentialEnv({ GIT_CONFIG_PARAMETERS: "'http.extraheader'='AUTHORIZATION: bearer invented-bearer-1234'", GIT_EDITOR: 'true' });
  assert.deepEqual(env, { GIT_EDITOR: 'true' });
});

test('which git settings pass: the listed sections, and in core not the commands that reach a remote', () => {
  for (const key of ['user.name', 'user.email', 'author.name', 'committer.email', 'safe.directory', 'core.longpaths', 'CORE.AutoCRLF', 'init.defaultBranch', 'diff.renames', 'color.ui', 'i18n.logOutputEncoding']) {
    assert.equal(isLocalGitSetting(key), true, key);
  }
  for (const key of [
    'http.extraheader', 'http.https://example.invalid/.extraheader', 'http.proxy', 'credential.helper', 'credential.https://example.invalid.username',
    'url.https://bot:token@example.invalid/.insteadOf', 'remote.origin.url', 'sendemail.smtpPass', 'include.path', 'alias.publish',
    'core.sshCommand', 'core.askPass', 'core.gitProxy', 'nosection', '.name', '',
  ]) {
    assert.equal(isLocalGitSetting(key), false, key);
  }
});

test('the variables that are not git settings are filtered by name as before', () => {
  const env = stripCredentialEnv({ SOMETHING_API_KEY: 'x', SERVICE_TOKEN: 'x', PATH: '/bin', GIT_DIR: '/repo/.git', GIT_AUTHOR_NAME: 'Invented Name' });
  assert.deepEqual(env, { PATH: '/bin', GIT_DIR: '/repo/.git', GIT_AUTHOR_NAME: 'Invented Name' });
});

test('the shell’s environment: the credentials gone, and after the settings that were given two of its own — no credential helper, then core.longpaths, the last — so git typed into the shell reads deep paths as the program’s own calls do', () => {
  assert.deepEqual(shellEnv({ PATH: '/bin', SERVICE_TOKEN: 'x' }), {
    PATH: '/bin', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'core.longpaths', GIT_CONFIG_VALUE_1: 'true',
  });
  const env = shellEnv(envWith([['http.extraheader', 'AUTHORIZATION: bearer invented-bearer-1234'], ['user.name', 'Invented Name'], ['core.longpaths', 'false']]));
  assert.deepEqual(group(env), {
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Invented Name',
    GIT_CONFIG_KEY_1: 'core.longpaths', GIT_CONFIG_VALUE_1: 'false',
    GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '',
    GIT_CONFIG_KEY_3: 'core.longpaths', GIT_CONFIG_VALUE_3: 'true',
  });
  assert.equal(gitWith(env, ['config', '--get', 'core.longpaths']).trim(), 'true', 'the last one holds');
});

// ───────────────────────── the routes to a stored login ─────────────────────────

/** A repository of its own, with a history to read, and a global configuration that names an invented credential helper. */
function repositoryWithHelper(): { repo: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'pk-shell-logins-'));
  const repo = join(dir, 'kestrel');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'gitconfig'), '[credential]\n\thelper = "!f() { echo username=invented-user; echo password=invented-password-7788; }; f"\n[user]\n\tname = Kestrel Dev\n\temail = dev@kestrel.invalid\n');
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(GIT_|SSH_ASKPASS|VSCODE_GIT_|GCM_)/i.test(k)) env[k] = v;
  Object.assign(env, { GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' });
  const git = (...args: string[]) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-C', repo, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# Kestrel\n\nA sheet for counting birds.\n');
  writeFileSync(join(repo, 'docs', 'plan.md'), '# Plan\n\n- K-1 count by species\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'K-1: first version');
  writeFileSync(join(repo, 'docs', 'plan.md'), '# Plan\n\n- K-1 count by species\n- K-2 count at dusk\n');
  return { repo, env };
}
/** What git prints and how it ends, for one command with one environment; standard input as given. */
const run = (env: NodeJS.ProcessEnv, cwd: string, args: readonly string[], input = ''): { status: number | null; out: string; err: string } => {
  const r = spawnSync('git', args, { env, cwd, input, encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};

test('git in the shell asks no credential helper and no one else: a stored login is not handed out, and git says so at once instead of waiting for an answer', () => {
  const { repo, env } = repositoryWithHelper();
  const ask = 'protocol=https\nhost=example.invalid\n\n';
  assert.match(run({ ...env, GIT_TERMINAL_PROMPT: '0' }, repo, ['credential', 'fill'], ask).out, /password=invented-password-7788/, 'the helper answers git as the machine is set up');
  const inShell = run(shellEnv(env), repo, ['credential', 'fill'], ask);
  assert.notEqual(inShell.status, 0);
  assert.doesNotMatch(inShell.out + inShell.err, /invented-password-7788|invented-user/, 'nothing of the stored login');
  assert.match(inShell.err, /terminal prompts disabled/);
});

test('the programs that answer for a password, the editor’s channel to its own sign-in and git’s trace switches do not reach the shell', () => {
  const given = {
    PATH: '/bin', GIT_EDITOR: 'true', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', TERM_PROGRAM: 'vscode',
    GIT_ASKPASS: '/editor/extensions/git/dist/askpass.sh', SSH_ASKPASS: '/editor/extensions/git/dist/ssh-askpass.sh', SSH_ASKPASS_REQUIRE: 'force', SUDO_ASKPASS: '/usr/bin/ask',
    VSCODE_GIT_ASKPASS_NODE: '/editor/node', VSCODE_GIT_ASKPASS_MAIN: '/editor/askpass-main.js', VSCODE_GIT_ASKPASS_EXTRA_ARGS: '', VSCODE_GIT_IPC_HANDLE: '/tmp/vscode-git.sock', VSCODE_GIT_IPC_AUTH_TOKEN: 'invented', vscode_git_editor_node: '/editor/node',
    GIT_TRACE: '1', GIT_TRACE_CURL: '1', GIT_TRACE_REDACT: '0', GIT_TRACE_PACKET: '1', GIT_TRACE2_EVENT: '/tmp/trace', Git_Curl_Verbose: '1', GCM_TRACE: '1', GCM_TRACE_SECRETS: '1',
    GIT_TERMINAL_PROMPT: '1',
  };
  const { GIT_CONFIG_COUNT: _count, GIT_CONFIG_KEY_0: _k0, GIT_CONFIG_VALUE_0: _v0, GIT_CONFIG_KEY_1: _k1, GIT_CONFIG_VALUE_1: _v1, ...rest } = shellEnv(given);
  assert.deepEqual(rest, { PATH: '/bin', GIT_EDITOR: 'true', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes', TERM_PROGRAM: 'vscode', GIT_TERMINAL_PROMPT: '0' });
});

test('what the Keeper reads of a repository in its shell comes out the same: log, show, status, diff, blame, ls-files, worktree list', () => {
  const { repo, env } = repositoryWithHelper();
  for (const args of [
    ['log', '--format=%H %an %s'], ['show', '--stat', 'HEAD'], ['status', '--porcelain'], ['diff'], ['blame', '--porcelain', 'README.md'],
    ['ls-files'], ['worktree', 'list', '--porcelain'], ['rev-parse', 'HEAD'], ['var', 'GIT_AUTHOR_IDENT'], ['config', '--local', '--list'],
  ]) {
    const before = run(env, repo, args);
    const inShell = run(shellEnv({ ...env, GIT_ASKPASS: '/editor/askpass.sh', GIT_TRACE: '1' }), repo, args);
    assert.equal(before.status, 0, `git ${args.join(' ')}: ${before.err}`);
    const timeless = (r: typeof before) => ({ ...r, out: r.out.replace(/ \d{10} [+-]\d{4}/g, '') });
    assert.deepEqual(timeless(inShell), timeless(before), `git ${args.join(' ')}`);
  }
});
