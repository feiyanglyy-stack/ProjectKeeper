// Node runs ProjectKeeper's TypeScript sources as they are, by stripping the types — except for files under a
// node_modules directory, which it refuses. So when ProjectKeeper is installed as a package (not run from a clone),
// this module does the same stripping for ProjectKeeper's own .ts files, and for nothing else. It is loaded by
// bin/pk.mjs and bin/postinstall.mjs, and handed on to the worker thread and the child process ProjectKeeper starts
// (src/util/own-ts.ts). In a clone it is never loaded.
import * as nodeModule from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url).href;
const own = (url) => url.startsWith(root) && !url.slice(root.length).includes('node_modules/') && url.endsWith('.ts');

if (typeof nodeModule.registerHooks !== 'function' || typeof nodeModule.stripTypeScriptTypes !== 'function') {
  throw new Error(`ProjectKeeper needs Node.js 24 or later to run from an installed package (this is ${process.version}).`);
}
nodeModule.registerHooks({
  load(url, context, nextLoad) {
    if (!own(url)) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: nodeModule.stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')) };
  },
});
