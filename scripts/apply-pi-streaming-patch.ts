import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { files, version, type PatchFile } from '../patches/pi-ai-0.87.1.ts';

export const label = 'ProjectKeeper pi-ai patch';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const count = (text: string, part: string) => text.split(part).length - 1;
function replaceOnce(text: string, from: string, to: string): string {
  if (count(text, from) !== 1) throw new Error('patch context must occur exactly once');
  return text.replace(from, () => to);
}

/**
 * The upstream text of a file, given the file as installed: upstream itself, patched by this generation of the patch,
 * or patched by an earlier generation — which applied a prefix of each file's replacements, since later generations
 * only append theirs. Replacements are undone last to first; one whose result is absent was never applied and is
 * skipped. Whatever path is taken, only a text with the upstream hash is accepted.
 */
export function originalSource(text: string, patch: PatchFile): string {
  if (hash(text) === patch.sha256) return text;
  const original = [...patch.replacements].reverse().reduce((s, [from, to]) => {
    const applied = count(s, to);
    if (applied > 1) throw new Error('patch context must occur exactly once');
    return applied === 1 ? s.replace(to, () => from) : s;
  }, text);
  if (hash(original) !== patch.sha256) throw new Error('source SHA-256 mismatch');
  return original;
}

/** Where a package is installed for code in `from`, the way Node looks it up: the nearest node_modules above that has it. */
function installedFor(from: string, name: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const at = join(dir, 'node_modules', ...name.split('/'));
    if (existsSync(join(at, 'package.json'))) return realpathSync(at);
    if (dirname(dir) === dir) return null;
  }
}

/**
 * The installed copies of pi-ai. In a clone the lockfile names every location. Installed as a package ProjectKeeper has
 * no lockfile of its own: the copies are then the one pi-coding-agent loads (the Keeper's runtime) and the one
 * ProjectKeeper's own code would load, where they differ.
 */
async function piAiCopies(root: string): Promise<{ dir: string; locked: string | null }[]> {
  const lockFile = resolve(root, 'package-lock.json');
  if (existsSync(lockFile)) {
    const lock = JSON.parse(await readFile(lockFile, 'utf8')) as { packages: Record<string, { version?: string }> };
    const packages = Object.entries(lock.packages).filter(([p]) => /(?:^|\/)node_modules\/@earendil-works\/pi-ai$/.test(p));
    if (!packages.length) throw new Error(`${label}: pi-ai is missing from the lockfile`);
    return packages.map(([location, locked]) => ({ dir: resolve(root, location), locked: locked.version ?? '' }));
  }
  const agent = installedFor(root, '@earendil-works/pi-coding-agent');
  const dirs = [agent && installedFor(agent, '@earendil-works/pi-ai'), installedFor(root, '@earendil-works/pi-ai')].filter((d): d is string => d !== null);
  if (!dirs.length) throw new Error(`${label}: pi-ai is not installed where ${root} would load it from`);
  return [...new Set(dirs)].map((dir) => ({ dir, locked: null }));
}

/** Validate every installed copy and every file before writing anything. Safe to repeat. */
export async function applyPiStreamingPatch(root = fileURLToPath(new URL('../', import.meta.url))) {
  const packages = await piAiCopies(root);
  const writes: { path: string; content: string }[] = [];
  for (const { dir, locked } of packages) {
    const installed = JSON.parse(await readFile(resolve(dir, 'package.json'), 'utf8')) as { version: string };
    if (installed.version !== version || (locked !== null && locked !== version)) throw new Error(`${label}: expected pi-ai ${version}, got installed=${installed.version}${locked === null ? '' : `, locked=${locked}`}; review the patch before upgrading`);
    for (const patch of files) {
      const path = resolve(dir, patch.path);
      try {
        const current = await readFile(path, 'utf8');
        const original = originalSource(current, patch);
        const content = patch.replacements.reduce((s, [from, to]) => replaceOnce(s, from, to), original);
        if (content !== current) writes.push({ path, content });
      } catch (error) {
        throw new Error(`${label}: ${patch.path} differs from supported ${version}; refusing to continue (a reinstall, npm ci, restores the upstream files). ${String(error)}`);
      }
    }
  }
  for (const { path, content } of writes) await writeFile(path, content);
  return { copies: packages.length, changedFiles: writes.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`${label}:`, await applyPiStreamingPatch());
}
