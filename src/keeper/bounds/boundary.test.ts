/**
 * Allowed roots that do not come from the project itself — the toolchain and the skills pi loaded — are refused
 * when they are too broad (Spec §3.1; CKC-03 AC-23). A skill file sitting directly under the home directory must not
 * open the home directory; a toolchain entry naming a directory that contains the project must not open it either,
 * even when a stored entry still says it is used. The skill file itself stays readable, so the skill keeps working.
 * The "home" and the ProjectKeeper home are temp directories passed in; nothing real is touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Project } from '../../model/types.ts';
import type { ProjectStore } from '../../store/project-store.ts';
import { allowedRoots } from './boundary.ts';
import { makeBoundary } from './paths.ts';
import { pathKey } from '../../util/paths.ts';

function fixture() {
  const t = mkdtempSync(join(tmpdir(), 'pk-roots-'));
  const home = join(t, 'home');
  const pkHome = join(t, 'pk-home');
  const storeDir = join(pkHome, 'projects', 'proj-1');
  const work = join(t, 'work');
  const project = join(work, 'project');
  const goodSkill = join(t, 'skills', 'good-skill');
  for (const d of [join(home, 'another-project'), storeDir, project, join(work, 'neighbour'), goodSkill]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, 'loose-skill.md'), '---\ndescription: a skill file directly under the home directory\n---\n');
  writeFileSync(join(home, 'another-project', 'notes.txt'), 'another project');
  writeFileSync(join(goodSkill, 'SKILL.md'), '---\ndescription: a skill in its own folder\n---\n');
  writeFileSync(join(goodSkill, 'reference.md'), 'a file the skill refers to');
  writeFileSync(join(work, 'neighbour', 'file.txt'), 'next to the project, not in it');
  writeFileSync(join(project, 'README.md'), '# project');

  const loader = {
    getSkills: () => ({ skills: [
      { filePath: join(home, 'loose-skill.md'), baseDir: home },
      { filePath: join(goodSkill, 'SKILL.md'), baseDir: goodSkill },
    ] }),
    getExtensions: () => ({ extensions: [], errors: [] }),
    getPrompts: () => ({ prompts: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPromptSource: () => undefined,
    getAppendSystemPromptSources: () => [],
  } as unknown as DefaultResourceLoader;
  const store = { dir: storeDir, sources: { all: () => [] } } as unknown as ProjectStore;
  const projectRecord = {
    id: 'proj-1', name: 'Demo', locations: [project], scope: [],
    // A stored entry that still says "used" although it names a directory containing the project.
    toolchain: [{ path: work, reason: 'local.properties declares parent.dir', configPath: join(project, 'local.properties'), used: true, notUsedReason: null }],
  } as unknown as Project;
  const deps = {
    project: projectRecord, store, agentDir: join(t, 'agent'), settingsManager: {} as unknown as SettingsManager,
    resolveLoader: () => loader, home, projectKeeperHome: pkHome,
  };
  return { t, home, work, project, goodSkill, deps };
}

test('a skill directory that is the home directory is not an allowed root; the skill file itself stays readable', () => {
  const { home, goodSkill, project, deps } = fixture();
  const { roots, files, refused } = allowedRoots(deps) as ReturnType<typeof allowedRoots> & { refused?: { path: string; reason: string }[] };
  const boundary = makeBoundary({ roots, files });

  assert.equal(boundary.decide(join(goodSkill, 'reference.md'), project).ok, true, 'a narrow skill folder is readable');
  assert.equal(boundary.decide(join(home, 'loose-skill.md'), project).ok, true, 'the loose skill file itself is readable, so the skill works');
  const sibling = boundary.decide(join(home, 'another-project', 'notes.txt'), project);
  assert.equal(sibling.ok, false, 'the home directory is not opened by a skill file sitting in it');
  assert.match(sibling.reason ?? '', /read boundary/);
  assert.ok((refused ?? []).some((r) => pathKey(r.path) === pathKey(home) && /^not used: too broad \(the whole home directory\)/.test(r.reason)),
    'the refused skill root is kept visible with its reason');
});

test('a toolchain entry naming a directory that contains the project is not an allowed root, even if stored as used', () => {
  const { work, project, deps } = fixture();
  const { roots, files, refused } = allowedRoots(deps) as ReturnType<typeof allowedRoots> & { refused?: { path: string; reason: string }[] };
  const boundary = makeBoundary({ roots, files });

  assert.equal(boundary.decide(join(project, 'README.md'), project).ok, true, 'the project itself stays readable');
  const neighbour = boundary.decide(join(work, 'neighbour', 'file.txt'), project);
  assert.equal(neighbour.ok, false, 'a directory next to the project is not opened through the toolchain entry');
  assert.ok((refused ?? []).some((r) => pathKey(r.path) === pathKey(work) && /^not used: too broad \(it contains the project directory\)/.test(r.reason)),
    'the refused toolchain root is kept visible with its reason');
});
