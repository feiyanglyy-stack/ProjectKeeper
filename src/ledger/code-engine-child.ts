/**
 * The code engine's child process (code-engine.ts). It is started with V8's `--liftoff-only`, `DO_NOT_TRACK=1` and git
 * blind to any repository around it, never inside a project, and prints one JSON line:
 *
 *   index <tree>      index the snapshot, or bring its index up to date (`sync`); an interrupted or outdated index is made
 *                     again from nothing
 *   imports <path>    stdin: a JSON array of versions of one file (a version may be null); for each, the import specifiers
 *                     the engine extracts from it
 *
 * It imports nothing of ProjectKeeper, so starting it costs Node and the engine only.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { CodeGraph as CodeGraphInstance } from '@colbymchenry/codegraph';

type EngineModule = typeof import('@colbymchenry/codegraph');
const lib = createRequire(import.meta.url)('@colbymchenry/codegraph') as EngineModule;
lib.setLogger(lib.silentLogger);

const print = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const peakMemoryMB = (): number => Math.round(process.resourceUsage().maxRSS / 1024);

async function index(tree: string): Promise<void> {
  const started = performance.now();
  const { CodeGraph } = lib;
  let cg: CodeGraphInstance;
  let mode: 'full' | 'sync' = 'full';
  if (CodeGraph.isInitialized(tree)) {
    cg = await CodeGraph.open(tree);
    if (cg.getIndexState() === 'complete' && !cg.isIndexStale()) {
      await cg.sync();
      mode = 'sync';
    } else {
      cg.close();
      cg = await CodeGraph.recreate(tree);
      await cg.indexAll();
    }
  } else {
    cg = await CodeGraph.init(tree);
    await cg.indexAll();
  }
  const stats = cg.getStats();
  const state = cg.getIndexState();
  cg.close();
  // `partial`: finished, some files dropped — usable, and said; `failed` or still `indexing`: not usable.
  const usable = state !== 'failed' && state !== 'indexing';
  print({ ok: usable, mode, state, ms: Math.round(performance.now() - started), peakMemoryMB: peakMemoryMB(), files: stats.fileCount, nodes: stats.nodeCount, edges: stats.edgeCount, ...(usable ? {} : { error: `the index ended ${state}` }) });
}

async function imports(path: string): Promise<void> {
  const sources = JSON.parse(readFileSync(0, 'utf8')) as (string | null)[];
  const languages = [...new Set(sources.filter((s): s is string => typeof s === 'string').map((s) => lib.detectLanguage(path, s)))];
  await lib.initGrammars();
  await lib.loadGrammarsForLanguages(languages);
  // `extractFromSource` reads nothing of the instance it hangs on; it parses one text.
  const extract = lib.CodeGraph.prototype.extractFromSource;
  const out = sources.map((s) => (typeof s === 'string' ? extract.call(null as unknown as CodeGraphInstance, path, s).nodes.filter((n) => n.kind === 'import').map((n) => n.name) : null));
  print({ ok: true, imports: out, peakMemoryMB: peakMemoryMB() });
}

const [mode, arg] = process.argv.slice(2);
try {
  if (mode === 'index' && arg) await index(arg);
  else if (mode === 'imports' && arg) await imports(arg);
  else { print({ ok: false, error: `usage: index <tree> | imports <path> (got ${mode ?? 'nothing'})` }); process.exitCode = 2; }
} catch (error) {
  print({ ok: false, error: (error as Error).message });
  process.exitCode = 1;
}
